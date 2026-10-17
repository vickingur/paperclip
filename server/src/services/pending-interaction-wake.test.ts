import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { agents, agentWakeupRequests, companies, createDb, heartbeatRuns, issues, issueTreeHolds, issueThreadInteractions } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { isCurrentPendingInteractionAddressee, readPendingInteractionWake, retainSupersededPendingInteractionWake } from "./pending-interaction-wake.js";
import { createPostgresWakeQueueAdapter } from "../modules/wake-queue/adapters/postgres.js";
import { createReleaseIssueExecution } from "../modules/wake-queue/application/use-cases.js";
import { createPostgresRunDispatchAdapter } from "../modules/run-dispatch/adapters/postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;
suite("pending interaction delivery", () => {
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("pending-interaction-wake-");
    db = createDb(database.connectionString);
    await db.execute(sql`set client_min_messages to warning`);
  }, 20_000);
  beforeEach(async () => {
    await db.execute(sql`truncate table companies cascade`);
  });
  afterAll(async () => { await database?.cleanup(); });

  async function fixture(errorCode = "issue_assignee_changed", started = false) {
    const companyId = randomUUID(), ownerId = randomUUID(), recipientId = randomUUID();
    const issueId = randomUUID(), cardId = randomUUID(), runId = randomUUID(), wakeId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Synthetic company", defaultResponsibleUserId: "synthetic-user" });
    await db.insert(agents).values([ownerId, recipientId].map(id => ({ id, companyId, name: id,
      role: "engineer", status: "active", adapterType: "process", adapterConfig: {}, runtimeConfig: {}, permissions: {} })));
    await db.insert(issues).values({ id: issueId, companyId, title: "Synthetic question", status: "blocked",
      assigneeAgentId: ownerId, responsibleUserId: "synthetic-user" });
    await db.insert(issueThreadInteractions).values({ id: cardId, companyId, issueId, kind: "ask_user_questions",
      status: "pending", addresseeAgentId: recipientId, createdByAgentId: ownerId, payload: { version: 1, questions: [{ id: "input", prompt: "Synthetic input?", selectionMode: "single", options: [] }] } });
    const context = { issueId, interactionId: cardId, wakeReason: "interaction_pending" };
    await db.insert(agentWakeupRequests).values({ id: wakeId, companyId, agentId: recipientId,
      source: "automation", reason: "interaction_pending", status: "cancelled",
      requestedByActorType: "system", payload: { issueId, interactionId: cardId, mutation: "interaction" } });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId: recipientId, invocationSource: "automation",
      status: "cancelled", errorCode, finishedAt: new Date(), wakeupRequestId: wakeId, contextSnapshot: context,
      startedAt: started ? new Date() : null,
      resultJson: started ? { executionCancellation: { state: "acknowledged" },
        executionRecovery: { kind: "interrupted", providerStopped: true, sessionPreserved: true, actionOutcomes: "settled" } }
        : { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } });
    await db.update(agentWakeupRequests).set({ runId }).where(eq(agentWakeupRequests.id, wakeId));
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    return { companyId, ownerId, recipientId, issueId, cardId, runId, wakeId, context, run, issue };
  }
  const release = (companyId: string, runId: string) => createReleaseIssueExecution({
    issueLock: createPostgresWakeQueueAdapter(db, {
      resolveResponsibleUserId: async () => "synthetic-user",
      getRoutineEnv: async () => ({ routineId: null, env: null, responsibleUserId: "synthetic-user" }),
      resolveSessionBeforeForWakeup: async () => null,
    }),
    recovery: { escalateStrandedAssignedIssue: async () => {}, escalateStrandedRecoveryIssueInPlace: async () => {} },
  })({ companyId, runId, now: new Date(), suppressImmediateRecovery: true });

  it.each([false, true])("drains the assignee wake after an unavailable retained recipient unless the stop was acknowledged (acknowledged=%s)", async acknowledged => {
    const f = await fixture("issue_assignee_changed", acknowledged);
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.recipientId));
    const ownerWakeId = randomUUID();
    await db.insert(agentWakeupRequests).values({ id: ownerWakeId, companyId: f.companyId, agentId: f.ownerId,
      source: "automation", reason: "issue_assigned", status: "deferred_issue_execution",
      requestedByActorType: "system", requestedAt: new Date(0), payload: { issueId: f.issueId } });

    const result = await release(f.companyId, f.runId);
    const [retained] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.wakeId));
    const [ownerWake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, ownerWakeId));
    // The older assignment receipt must not bypass recovery's priority.
    expect(retained.status).toBe("failed");
    expect(ownerWake.status).toBe(acknowledged ? "deferred_issue_execution" : "queued");
    expect(result.outcome.kind).toBe(acknowledged ? "released" : "promoted");
    if (!acknowledged) {
      const [successor] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, ownerWake.runId!));
      expect(successor.agentId).toBe(f.ownerId);
      expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0].executionRunId).toBe(successor.id);
    }
  });

  it("dispatches to the live card recipient even when the task has another owner", async () => {
    const f = await fixture();
    await db.update(heartbeatRuns).set({ status: "queued", errorCode: null }).where(eq(heartbeatRuns.id, f.runId));
    expect(await isCurrentPendingInteractionAddressee(db, f.companyId, f.issueId, f.recipientId, f.context)).toBe(true);
    expect(await createPostgresRunDispatchAdapter(db).cancelStaleQueuedRun({ companyId: f.companyId, runId: f.runId,
      expectedStatus: "queued", now: new Date() })).toMatchObject({ outcome: "not_stale" });
  });

  it.each([false, true])("retains one superseded delivery and promotes it (started=%s)", async started => {
    const f = await fixture("issue_assignee_changed", started);
    const result = await release(f.companyId, f.runId);
    expect(result.outcome.kind).toBe("promoted");
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.wakeId));
    expect(wake).toMatchObject({ agentId: f.recipientId, status: "queued",
      payload: { pendingInteractionRecoveryRunId: f.runId } });
    expect(wake.runId).not.toBe(f.runId);
    // Repeated completion callbacks must not create another follow-up.
    await release(f.companyId, f.runId);
    expect(await db.select().from(heartbeatRuns)).toHaveLength(2);
    const [followup] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, wake.runId!));
    await db.update(heartbeatRuns).set({ status: "cancelled", errorCode: "issue_assignee_changed" })
      .where(eq(heartbeatRuns.id, followup.id));
    expect(await retainSupersededPendingInteractionWake(db, { ...followup, status: "cancelled",
      errorCode: "issue_assignee_changed" }, f.issue, new Date())).toBe(false);
  });

  it.each(["cancelled", "agent_paused", "budget_blocked", "issue_paused", "issue_dependencies_blocked"])(
    "never retries intentional stops or policy denials (%s)", async code => {
      const f = await fixture(code, true);
      expect(await retainSupersededPendingInteractionWake(db, f.run, f.issue, new Date())).toBe(false);
      expect((await db.select().from(agentWakeupRequests))[0].status).toBe("cancelled");
    });

  it.each(["answered", "withdrawn", "rejected", "expired"])("does not replay a %s card", async status => {
    const f = await fixture();
    await db.update(issueThreadInteractions).set({ status }).where(eq(issueThreadInteractions.id, f.cardId));
    expect(await readPendingInteractionWake(db, f.companyId, f.issueId, f.context)).toBeNull();
    expect(await retainSupersededPendingInteractionWake(db, f.run, f.issue, new Date())).toBe(false);
    // Even the task owner cannot run stale attention to a resolved card.
    await db.update(heartbeatRuns).set({ status: "queued", agentId: f.ownerId }).where(eq(heartbeatRuns.id, f.runId));
    expect(await createPostgresRunDispatchAdapter(db).cancelStaleQueuedRun({ companyId: f.companyId,
      runId: f.runId, expectedStatus: "queued", now: new Date() })).toMatchObject({ outcome: "cancelled" });
  });

  it("retargets retained attention to the current recipient", async () => {
    const f = await fixture();
    await db.update(issueThreadInteractions).set({ addresseeAgentId: f.ownerId }).where(eq(issueThreadInteractions.id, f.cardId));
    expect((await release(f.companyId, f.runId)).outcome.kind).toBe("promoted");
    expect((await db.select().from(agentWakeupRequests))[0]).toMatchObject({ agentId: f.ownerId, status: "queued" });
  });

  it("coalesces a cancelled delivery behind an existing follow-up", async () => {
    const f = await fixture();
    await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.recipientId,
      source: "automation", status: "deferred_issue_execution", reason: "issue_execution_deferred",
      payload: { issueId: f.issueId, interactionId: f.cardId, mutation: "interaction",
        _paperclipWakeContext: f.context }, requestedByActorType: "system" });
    expect(await retainSupersededPendingInteractionWake(db, f.run, f.issue, new Date())).toBe(false);
    expect((await release(f.companyId, f.runId)).outcome.kind).toBe("promoted");
    expect(await db.select().from(heartbeatRuns)).toHaveLength(2);
  });

  it.each(["human_only", "not_creator"] as const)("preserves the resolver audience (%s)", async policy => {
    const f = await fixture();
    await db.update(issueThreadInteractions).set({ effectiveResolverPolicy: policy,
      createdByAgentId: f.recipientId }).where(eq(issueThreadInteractions.id, f.cardId));
    expect(await readPendingInteractionWake(db, f.companyId, f.issueId, f.context)).toBeNull();
  });

  it("keeps attention behind an active successor and promotes it on successor release", async () => {
    const f = await fixture();
    const successorId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: successorId, companyId: f.companyId, agentId: f.ownerId,
      invocationSource: "assignment", status: "running", contextSnapshot: { issueId: f.issueId } });
    await db.update(issues).set({ executionRunId: successorId }).where(eq(issues.id, f.issueId));
    expect((await release(f.companyId, f.runId)).outcome.kind).toBe("released");
    expect((await db.select().from(agentWakeupRequests))[0].status).toBe("deferred_issue_execution");
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, successorId));
    expect((await release(f.companyId, successorId)).outcome.kind).toBe("promoted");
    expect(await db.select().from(heartbeatRuns)).toHaveLength(3);
  });

  it("does not restart provider work while an earlier outcome needs reconciliation", async () => {
    const f = await fixture("issue_assignee_changed", true);
    await db.update(heartbeatRuns).set({ resultJson: { executionCancellation: { state: "acknowledged" } } })
      .where(eq(heartbeatRuns.id, f.runId));
    expect((await release(f.companyId, f.runId)).outcome.kind).toBe("released");
    expect((await db.select().from(agentWakeupRequests))[0].status).toBe("deferred_issue_execution");
    expect(await db.select().from(heartbeatRuns)).toHaveLength(1);
  });

  it("preserves an operator stop even with an automatic supersession error code", async () => {
    const f = await fixture();
    const run = { ...f.run, resultJson: { ...f.run.resultJson, cancellation: {
      source: "operator", expected: true, initiator: { type: "user", id: "synthetic-user" },
      reason: "Stop", recordedAt: new Date().toISOString(),
    } } };
    expect(await retainSupersededPendingInteractionWake(db, run, f.issue, new Date())).toBe(false);
  });

  it("does not promote attention through a subtree pause", async () => {
    const f = await fixture();
    await db.insert(issueTreeHolds).values({ companyId: f.companyId, rootIssueId: f.issueId,
      mode: "pause", status: "active", createdByActorType: "user" });
    expect((await release(f.companyId, f.runId)).outcome.kind).toBe("released");
    expect(await db.select().from(heartbeatRuns)).toHaveLength(1);
  });

  it.each(["answered", "recipient_changed"])("rechecks a pending card at final provider dispatch (%s)", async state => {
    const f = await fixture();
    await db.update(heartbeatRuns).set({ status: "running", errorCode: null, resultJson: null })
      .where(eq(heartbeatRuns.id, f.runId));
    await db.update(issueThreadInteractions).set(state === "answered" ? { status: "answered" }
      : { addresseeAgentId: f.ownerId }).where(eq(issueThreadInteractions.id, f.cardId));
    let entered = false;
    const result = await createPostgresRunDispatchAdapter(db).dispatchResolvedInteractionIfCurrent({
      companyId: f.companyId, runId: f.runId, expectedStatus: "running", now: new Date(),
      dispatch: () => { entered = true; return Promise.resolve(); },
    });
    expect(result.dispatched).toBe(false);
    expect(entered).toBe(false);
  });

  it("rejects foreign scope, missing cards and untrusted wake context", async () => {
    const f = await fixture();
    for (const [companyId, issueId, context] of [
      [randomUUID(), f.issueId, f.context], [f.companyId, randomUUID(), f.context],
      [f.companyId, f.issueId, { ...f.context, interactionId: randomUUID() }],
      [f.companyId, f.issueId, { ...f.context, interactionId: "invalid" }],
      [f.companyId, f.issueId, { ...f.context, wakeReason: "issue_assigned" }],
    ] as const) expect(await readPendingInteractionWake(db, companyId, issueId, context)).toBeNull();
  });
});
