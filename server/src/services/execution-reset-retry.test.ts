import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, agentWakeupRequests, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { executionResetIdentity, findCommittedExecutionReset, type ExecutionResetIntent } from "./execution-reset-idempotency.js";
const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("durable execution reset retry", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("reset-retry-"); db = createDb(database.connectionString); }, 90_000);
  afterAll(async () => { await database?.cleanup(); });
  async function seed() {
    const companyId = randomUUID(), issueId = randomUUID(), agentId = randomUUID();
    const intent: ExecutionResetIntent = { companyId, issueId, principalId: "board", idempotencyKey: "retry",
      expectedHoldingRunId: randomUUID(), expectedRecoveryActionId: randomUUID(), fingerprint: "proof", acknowledgeFreshHistoryAwareTurn: true };
    const identity = executionResetIdentity(intent);
    const response = { resetId: randomUUID(), issueId, successorRunId: randomUUID(), previousRunId: intent.expectedHoldingRunId };
    const boardExecutionReset = { resetId: response.resetId, actorId: intent.principalId, fingerprint: intent.fingerprint,
      expectedHoldingRunId: intent.expectedHoldingRunId, expectedRecoveryActionId: intent.expectedRecoveryActionId,
      previousRunId: response.previousRunId, acknowledgeFreshHistoryAwareTurn: true };
    const payload = { issueId, boardExecutionReset, executionResetCommit: { payloadDigest: identity.payloadDigest, response } };
    await db.insert(companies).values({ id: companyId, name: "Synthetic retry", issuePrefix: `R${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Synthetic owner", role: "engineer", adapterType: "process" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Synthetic task", assigneeAgentId: agentId });
    await db.insert(agentWakeupRequests).values({ id: response.resetId, companyId, agentId, source: "on_demand",
      reason: "execution_reset", status: "coalesced", runId: response.successorRunId, payload,
      requestedByActorType: "user", requestedByActorId: intent.principalId, idempotencyKey: identity.scopedKey });
    await db.insert(heartbeatRuns).values({ id: response.successorRunId, companyId, agentId, status: "queued",
      wakeupRequestId: response.resetId, contextSnapshot: { issueId, boardExecutionReset, forceFreshSession: true } });
    return { intent, response, payload, boardExecutionReset };
  }
  it("replays the exact commit after completion without another run", async () => {
    const f = await seed();
    expect(await findCommittedExecutionReset(db, f.intent)).toEqual(f.response);
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.response.successorRunId));
    expect(await findCommittedExecutionReset(db, f.intent)).toEqual(f.response);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.intent.companyId))).toHaveLength(1);
  });
  it("isolates principals and keys, rejects changed intent", async () => {
    const f = await seed();
    expect(await findCommittedExecutionReset(db, { ...f.intent, principalId: "other" })).toBeNull();
    expect(await findCommittedExecutionReset(db, { ...f.intent, idempotencyKey: "other" })).toBeNull();
    expect(await findCommittedExecutionReset(db, { ...f.intent, companyId: randomUUID() })).toBeNull();
    await expect(findCommittedExecutionReset(db, { ...f.intent, fingerprint: "changed" })).rejects.toThrow("idempotency_conflict");
  });
  it.each(["coalesced", "failed", "cancelled", "skipped"])("keeps the reset key consumed after %s", async status => {
    const f = await seed();
    await db.update(agentWakeupRequests).set({ status }).where(eq(agentWakeupRequests.id, f.response.resetId));
    const [request] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.response.resetId));
    await expect(db.insert(agentWakeupRequests).values({ ...request, id: randomUUID() })).rejects.toThrow();
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.intent.companyId))).toHaveLength(1);
  });
  it("fences concurrent reset receipt inserts to one winner", async () => {
    const f = await seed();
    const [request] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.response.resetId));
    const idempotencyKey = `${request.idempotencyKey}:race`;
    const results = await Promise.allSettled([1, 2].map(() => db.insert(agentWakeupRequests)
      .values({ ...request, id: randomUUID(), idempotencyKey })));
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
  });
  it("rollback releases an uncommitted reset key", async () => {
    const f = await seed();
    const [request] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.response.resetId));
    const row = { ...request, id: randomUUID(), idempotencyKey: `${request.idempotencyKey}:rollback` };
    await expect(db.transaction(async tx => {
      await tx.insert(agentWakeupRequests).values(row);
      throw new Error("synthetic rollback");
    })).rejects.toThrow("synthetic rollback");
    await db.insert(agentWakeupRequests).values(row);
  });
  it.each(["coalesced", "claimed", "completed", "failed", "cancelled", "skipped"])("replays the committed response after delivery becomes %s", async status => {
    const f = await seed();
    await db.update(agentWakeupRequests).set({ status }).where(eq(agentWakeupRequests.id, f.response.resetId));
    expect(await findCommittedExecutionReset(db, f.intent)).toEqual(f.response);
  });
  it.each(["principal", "requestRun", "responseRun", "missingCommit", "status", "savedContext", "wakeupLink"])("fails closed on changed %s", async field => {
    const f = await seed();
    if (field === "principal") await db.update(agentWakeupRequests).set({ requestedByActorId: "other" }).where(eq(agentWakeupRequests.id, f.response.resetId));
    if (field === "requestRun") await db.update(agentWakeupRequests).set({ runId: randomUUID() }).where(eq(agentWakeupRequests.id, f.response.resetId));
    if (field === "responseRun") await db.update(agentWakeupRequests).set({ payload: { ...f.payload,
      executionResetCommit: { ...f.payload.executionResetCommit, response: { ...f.response, successorRunId: randomUUID() } },
    } }).where(eq(agentWakeupRequests.id, f.response.resetId));
    if (field === "missingCommit") await db.update(agentWakeupRequests).set({ payload: { issueId: f.intent.issueId } }).where(eq(agentWakeupRequests.id, f.response.resetId));
    if (field === "status") await db.update(agentWakeupRequests).set({ status: "pending" }).where(eq(agentWakeupRequests.id, f.response.resetId));
    if (field === "savedContext") await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.intent.issueId, forceFreshSession: true, boardExecutionReset: { ...f.boardExecutionReset, actorId: "other" } } }).where(eq(heartbeatRuns.id, f.response.successorRunId));
    if (field === "wakeupLink") await db.update(heartbeatRuns).set({ wakeupRequestId: null }).where(eq(heartbeatRuns.id, f.response.successorRunId));
    await expect(findCommittedExecutionReset(db, f.intent)).rejects.toThrow();
  });
});
