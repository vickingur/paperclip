import * as recoveryModule from "./recovery/service.js";
import { dispositionSuppressionReceipt, isLegacyDispositionSuppressionVerified, settleLegacyDispositionSuppression } from "./legacy-disposition-suppression.js";
import { legacyExecutionNeedsReconciliationWithEvidence } from "./legacy-execution-recovery.js";
import express from "express";
import request from "supertest";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";
import { deliverExecutionReset } from "./execution-reset-delivery.js";
import { getServerAdapter } from "../adapters/index.js";
import { inspectExecutionReset } from "./execution-reset-inspection.js";
import { recordDependencyClosureProof, verifyDependencyClosureProof } from "./dependency-closure-proof.js";
import { legacyControllerBootId } from "./legacy-controller-lease.js";
import { instanceSettingsService } from "./instance-settings.js";
import { createPostgresWakeQueueAdapter } from "../modules/wake-queue/adapters/postgres.js";
import { createReleaseIssueExecution } from "../modules/wake-queue/application/use-cases.js";
import * as nativeExecutor from "./native-runtime/native-session-executor.js";
import { appendHeartbeatRunEvent } from "./heartbeat-run-events.js";
import { recordNativeLocalProcessStop, hasNativeLocalProcessStop, PROCESS_START_REQUESTED } from "./native-local-process-stop.js";
import { remoteTerminationReceipt } from "./remote-execution-termination.js";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import {
  authUsers, companyMemberships, approvals, projects, budgetPolicies, costEvents, issueApprovals, issueThreadInteractions, chatConversations, chatEndpoints, toolApplications, toolConnections,
  agentWakeupRequests, agents, companies, createDb, heartbeatRunEvents, heartbeatRuns, issueComments, issueRecoveryActions,
  issues, nativeRunFinalizations, nativeRunResults, completionContracts, environmentLeases, environments, issueRelations, issueTreeHolds, issueTreeHoldMembers,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase, getEmbeddedPostgresTestSupport } from "../__tests__/helpers/embedded-postgres.js";
import { admitBoardExecutionReset, admitDependencyClosureContinuation, admitExplicitNativeContinuation } from "./explicit-native-continuation.js";
import { adapterExecutionControls, createAdapterExecutionControl } from "./adapter-execution-control.js";
import { CONVERSATION_CONTINUATION_POLICY } from "./conversation-continuation.js";
import { buildExecutionContinuation } from "./execution-continuation.js";
import { heartbeatService, persistHeartbeatRunProcessMetadata, type HeartbeatEnvironmentRuntime } from "./heartbeat.js";
import { getExecutionBlocker } from "./execution-blocker.js";
import { createDurableChatWakeupRequest } from "./durable-chat-wakeup.js";
import { recordNativeFinalizationFailure } from "./native-runtime/native-run-finalizer.js";
const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("explicit native conversation continuation", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("explicit-native-message-"); db = createDb(database.connectionString); }, 90_000);
  afterAll(async () => { await database?.cleanup(); });
  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    const sourceRunId = randomUUID(), successorRunId = randomUUID();
    const commentId: string = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Explicit turn", defaultResponsibleUserId: "board", issuePrefix: `E${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Native", role: "engineer", adapterType: "paperclip_runner", status: "idle", runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Deploy", status: "blocked", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: sourceRunId, companyId, agentId,
      nativeIssueId: issueId, runtimeMode: "native", status: "failed", processPid: 999999999,
      contextSnapshot: { issueId }, finishedAt: new Date("2026-09-11T10:00:00Z") });
    await db.insert(nativeRunFinalizations).values({ runId: sourceRunId, companyId, issueId,
      phase: "terminal_failure", attempt: 3, failureDetail: { replacementDenied: "uncertain_external_action" } });
    await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId,
      kind: "active_run_watchdog", cause: "uncertain_external_action", fingerprint: sourceRunId,
      status: "resolved", outcome: "blocked", nextAction: "Automatic recovery stopped.",
      evidence: { runId: sourceRunId, automaticRecovery: { replay: "blocked", actionOutcome: "unknown" } } });
    await db.insert(issueComments).values({ id: commentId, companyId, issueId, authorType: "user",
      authorUserId: "board", body: "What happened?", createdAt: new Date("2026-09-11T11:00:00Z") });
    return { companyId, issueId, agentId, sourceRunId, commentId, successorRunId,
      actorType: "user", actorId: "board", reason: "issue_commented" };
  }
  type Fixture = Awaited<ReturnType<typeof seed>>;
  it.each(["valid", "concurrent retry", "unknown", "dependency", "paused agent", "paused company", "budget", "disabled wake", "daily cap", "stale fingerprint", "successor insert failure", "unrunnable workspace", "project workspace"] as const)(
    "commits actual queue reset admission and dispatch receipt (%s)", async state => {
      const f = await seed();
      const resultJson = { executionActionInventory: {
        schema: "paperclip.execution-actions.v1", source: "acp", complete: true,
        dispatch: "attempted", noActionsConfirmed: false,
        actions: [{ id: "queue-reset-original-effect", kind: "edit", status: "completed",
          outcome: state === "unknown" ? "unknown" : "completed" }],
      } };
      await db.update(heartbeatRuns).set({ resultJson }).where(eq(heartbeatRuns.id, f.sourceRunId));
      if (state === "dependency") {
        const id = randomUUID();
        await db.insert(issues).values({ id, companyId: f.companyId, title: "Required input", status: "todo" });
        await db.insert(issueRelations).values({ companyId: f.companyId, issueId: id, relatedIssueId: f.issueId, type: "blocks" });
      }
      if (state === "paused agent") await db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.agentId));
      if (state === "paused company") await db.update(companies).set({ status: "paused" }).where(eq(companies.id, f.companyId));
      if (state === "budget") {
        await db.insert(budgetPolicies).values({ companyId: f.companyId,
          scopeType: "agent", scopeId: f.agentId, windowKind: "lifetime", amount: 1 });
        await db.insert(costEvents).values({ companyId: f.companyId, agentId: f.agentId,
          provider: "synthetic", model: "synthetic", costCents: 1, occurredAt: new Date() });
      }
      if (state === "disabled wake") await db.update(agents).set({ runtimeConfig: { heartbeat: { wakeOnDemand: false } } }).where(eq(agents.id, f.agentId));
      if (state === "daily cap") {
        await db.update(agents).set({ runtimeConfig: { heartbeat: { dailyRunLimit: 1 } } }).where(eq(agents.id, f.agentId));
        await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
          status: "succeeded", startedAt: new Date(), finishedAt: new Date() });
      }
      if (["unrunnable workspace", "project workspace"].includes(state)) {
        await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });
        await db.update(issues).set({ executionWorkspaceSettings: {
          mode: "isolated_workspace", workspaceStrategy: { type: "git_worktree" },
        } }).where(eq(issues.id, f.issueId));
        if (state === "project workspace") {
          const projectId = randomUUID();
          await db.insert(projects).values({ id: projectId, companyId: f.companyId, name: "Synthetic workspace project" });
          await db.update(issues).set({ projectId }).where(eq(issues.id, f.issueId));
        }
      }
      const preview = (await inspectExecutionReset(db, f.companyId, f.issueId))!;
      const intent = { companyId: f.companyId, issueId: f.issueId, principalId: "board", idempotencyKey: "queue-reset",
        expectedHoldingRunId: f.sourceRunId, expectedRecoveryActionId: preview.holds[0].recoveryActionId,
        fingerprint: state === "stale fingerprint" ? "stale" : preview.fingerprint,
        acknowledgeFreshHistoryAwareTurn: true as const };
      const commit = () => heartbeatService(db).commitBoardExecutionReset(intent);
      if (state === "successor insert failure") {
        // Fail after real admission retires holds and the receipt is inserted.
        await db.execute(sql`create function synthetic_reset_insert_failure() returns trigger language plpgsql as
          'begin if NEW.context_snapshot->>''wakeReason'' = ''execution_reset'' then raise exception ''synthetic successor insert failure''; end if; return NEW; end'`);
        await db.execute(sql`create trigger synthetic_reset_insert_failure before insert on heartbeat_runs
          for each row execute function synthetic_reset_insert_failure()`);
        try { await expect(commit()).rejects.toMatchObject({ cause: { message: "synthetic successor insert failure" } }); }
        finally {
          await db.execute(sql`drop trigger synthetic_reset_insert_failure on heartbeat_runs`);
          await db.execute(sql`drop function synthetic_reset_insert_failure()`);
        }
      } else if (state === "unrunnable workspace") {
        try { await expect(commit()).rejects.toMatchObject({ details: { reason: "workspace_worktree_requires_project" } }); }
        finally { await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: false }); }
      } else if (!["valid", "concurrent retry", "project workspace"].includes(state)) await expect(commit()).rejects.toThrow();
      else {
        const responses = await Promise.all(Array.from({ length: state === "concurrent retry" ? 3 : 1 }, commit));
        expect(responses.every(response => JSON.stringify(response) === JSON.stringify(responses[0]))).toBe(true);
        const response = responses[0];
        const [successor] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, response.successorRunId));
        expect(successor.status).toBe("queued"); expect(successor.startedAt).toBeNull();
        expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
        const continuation = await buildExecutionContinuation({ db, companyId: f.companyId, issueId: f.issueId,
          agentId: f.agentId, runId: successor.id, context: successor.contextSnapshot!, summary: null, exposeLowTrustRaw: false });
        expect(continuation.completedActions).toContainEqual({ runId: f.sourceRunId,
          receiptId: "queue-reset-original-effect", operationId: "acp:edit", result: { status: "completed", outcome: "completed" } });
        // A committed retry reads its response even after availability changes.
        await db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.agentId));
        expect(await commit()).toEqual(response);
        if (state === "project workspace") await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: false });
      }
      const receipts = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId));
      expect(receipts).toHaveLength(["valid", "concurrent retry", "project workspace"].includes(state) ? 1 : 0);
      if (!["valid", "concurrent retry", "project workspace"].includes(state)) expect(await getExecutionBlocker(db, f.companyId, f.issueId)).not.toBeNull();
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.sourceRunId)))[0].resultJson).toEqual(resultJson);
    });
  it.each(["immediate", "concurrent retry", "startup", "start failure", "notification failure", "HTTP", "HTTP concurrent"] as const)(
    "delivers committed reset through synthetic legacy execution (%s)", async mode => {
      const f = await seed();
      await db.delete(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.sourceRunId));
      await db.update(agents).set({ adapterType: "codex_local", adapterConfig: { cwd: "/tmp" } }).where(eq(agents.id, f.agentId));
      await db.update(heartbeatRuns).set({ runtimeMode: "legacy", nativeIssueId: null,
        runnerProfileJson: { adapterDispatch: { adapterType: "codex_local" } },
        resultJson: { executionActionInventory: { schema: "paperclip.execution-actions.v1", source: "acp", complete: true,
          dispatch: "attempted", noActionsConfirmed: false,
          actions: [{ id: "retained-reset-write", kind: "edit", status: "completed", outcome: "completed" }] } },
      }).where(eq(heartbeatRuns.id, f.sourceRunId));
      await db.update(issueRecoveryActions).set({ cause: "legacy_execution_requires_reconciliation" }).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
      const preview = (await inspectExecutionReset(db, f.companyId, f.issueId))!;
      const intent = { companyId: f.companyId, issueId: f.issueId, principalId: "board", idempotencyKey: "delivery",
        expectedHoldingRunId: f.sourceRunId, expectedRecoveryActionId: preview.holds[0].recoveryActionId,
        fingerprint: preview.fingerprint, acknowledgeFreshHistoryAwareTurn: true as const };
      const app = express();
      if (mode.startsWith("HTTP")) {
        await db.insert(authUsers).values({ id: "board", name: "Synthetic board", email: "board@reset.test",
          createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
        await db.insert(companyMemberships).values({ companyId: f.companyId, principalType: "user",
          principalId: "board", status: "active", membershipRole: "admin" });
        app.use(express.json());
        app.use((req, _res, next) => {
          req.actor = { type: "board", userId: "board", companyIds: [f.companyId],
            memberships: [{ companyId: f.companyId, status: "active", membershipRole: "admin" }],
            isInstanceAdmin: false, source: "session" };
          next();
        });
        app.use("/api", issueRoutes(db, {} as any));
        app.use(errorHandler);
      }
      const { companyId: _company, issueId: _issue, principalId: _principal, ...body } = intent;
      const httpReset = async () => {
        const response = await request(app).post(`/api/issues/${f.issueId}/execution/reset`).send(body);
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        return response.body;
      };
      const execution = vi.spyOn(getServerAdapter("codex_local"), "execute").mockResolvedValue({ exitCode: 0, signal: null, timedOut: false, resultJson: { synthetic: true } });
      const heartbeat = heartbeatService(db);
      try {
        const failed = vi.fn();
        const start = vi.fn(async () => {
          if (mode === "start failure") throw new Error("synthetic start failure");
          return heartbeat.resumeQueuedRunsForAgent(f.companyId, f.agentId);
        });
        const response = mode === "HTTP" ? await httpReset()
          : mode === "HTTP concurrent" ? (await Promise.all([1, 2, 3].map(() => httpReset()))).reduce((first, value) => { expect(value).toEqual(first); return first; })
          : mode === "concurrent retry" ? (await Promise.all([1, 2, 3].map(() => heartbeat.resetBoardExecution(intent)))).reduce((first, value) => { expect(value).toEqual(first); return first; })
          : mode === "immediate" ? await heartbeat.resetBoardExecution(intent)
          : mode === "startup" ? await heartbeat.commitBoardExecutionReset(intent)
          : await deliverExecutionReset(db, intent, () => heartbeat.commitBoardExecutionReset(intent), {
            publish: () => { if (mode === "notification failure") throw new Error("synthetic notification failure"); }, start, failed });
        if (mode.endsWith("failure")) { expect(failed).toHaveBeenCalledTimes(1); expect(start).toHaveBeenCalledTimes(1); }
        if (["startup", "start failure"].includes(mode)) {
          expect(execution).not.toHaveBeenCalled();
          expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, response.successorRunId)))[0].status).toBe("queued");
          await heartbeatService(db).resumeQueuedRuns();
        }
        await vi.waitFor(async () => {
          expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, response.successorRunId)))[0].status).toBe("succeeded");
        }, { timeout: 10000 });
        expect(execution).toHaveBeenCalledTimes(1);
        expect(execution.mock.calls[0][0].context).toMatchObject({ forceFreshSession: true, previousRunId: f.sourceRunId });
        expect(execution.mock.calls[0][0].executionContinuation?.completedActions).toContainEqual({
          runId: f.sourceRunId, receiptId: "retained-reset-write", operationId: "acp:edit",
          result: { status: "completed", outcome: "completed" },
        });
        expect(await heartbeat.resetBoardExecution(intent)).toEqual(response);
        if (mode.startsWith("HTTP")) {
          expect(await httpReset()).toEqual(response);
          const conflict = await request(app).post(`/api/issues/${f.issueId}/execution/reset`)
            .send({ ...body, fingerprint: "changed" });
          expect(conflict.status).toBe(409);
          expect(conflict.body.error).toBe("execution_reset_idempotency_conflict");
        }
        expect(execution).toHaveBeenCalledTimes(1);
        expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toHaveLength(1);
      } finally { await heartbeat.drainActiveRunExecutions(); execution.mockRestore(); }
    });
  it.each(["normal", "intent insert rollback"] as const)(
    "owner HTTP handback produces one normal successor after retry (%s)", async mode => {
      const f = await seed();
      await db.delete(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.sourceRunId));
      await db.delete(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
      await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, f.sourceRunId));
      await db.update(agents).set({ adapterType: "codex_local", adapterConfig: { cwd: "/tmp" } }).where(eq(agents.id, f.agentId));
      await db.update(issues).set({ status: "todo", responsibleUserId: "board" }).where(eq(issues.id, f.issueId));
      let finishRepair!: () => void;
      const repairFinished = new Promise<void>(resolve => { finishRepair = resolve; });
      const execution = vi.spyOn(getServerAdapter("codex_local"), "execute")
        .mockImplementationOnce(async () => {
          await repairFinished;
          return { exitCode: 0, signal: null, timedOut: false };
        }).mockImplementationOnce(async context => {
          await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId,
            authorType: "agent", authorAgentId: f.agentId, createdByRunId: context.runId, body: "Normal work complete." });
          await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.issueId));
          return { exitCode: 0, signal: null, timedOut: false };
        });
      const heartbeat = heartbeatService(db);
      try {
        const repair = await heartbeat.wakeup(f.agentId, { source: "assignment", reason: "issue_assigned",
          payload: { issueId: f.issueId }, contextSnapshot: { issueId: f.issueId } });
        await vi.waitFor(() => expect(execution).toHaveBeenCalledTimes(1), { timeout: 10000 });
        await db.update(issues).set({ status: "in_progress", checkoutRunId: repair!.id,
          executionRunId: repair!.id }).where(eq(issues.id, f.issueId));
        await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId,
          authorType: "agent", authorAgentId: f.agentId, createdByRunId: repair!.id, body: "Review closed; handing back." });
        const actionId = randomUUID();
        await db.insert(issueRecoveryActions).values({ id: actionId, companyId: f.companyId, sourceIssueId: f.issueId,
          kind: "deliberate_wait_without_target", cause: "deliberate_wait_without_target", status: "active",
          ownerType: "agent", ownerAgentId: f.agentId, returnOwnerAgentId: f.agentId,
          fingerprint: actionId, nextAction: "Resume normal work",
          wakePolicy: { type: "bounded_owner_disposition_repair", retryAgentId: f.agentId } });
        const app = express();
        app.use(express.json());
        app.use((req, _res, next) => {
          req.actor = { type: "agent", agentId: f.agentId, companyId: f.companyId, runId: repair!.id, source: "agent_key" };
          next();
        });
        app.use("/api", issueRoutes(db, {} as any)); app.use(errorHandler);
        const resolve = () => request(app).post(`/api/issues/${f.issueId}/recovery-actions/resolve`)
          .send({ actionId, outcome: "restored", sourceIssueStatus: "todo" });
        if (mode === "intent insert rollback") {
          await db.execute(sql`create function synthetic_handback_failure() returns trigger language plpgsql as
            'begin if NEW.requested_by_actor_id = ''owner-disposition-handback'' then raise exception ''synthetic handback insert failure''; end if; return NEW; end'`);
          await db.execute(sql`create trigger synthetic_handback_failure before insert on agent_wakeup_requests
            for each row execute function synthetic_handback_failure()`);
          try {
            expect((await resolve()).status).toBe(500);
            expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0].status).toBe("in_progress");
            expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, actionId)))[0].status).toBe("active");
            expect(await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, f.companyId),
              eq(agentWakeupRequests.requestedByActorId, "owner-disposition-handback")))).toHaveLength(0);
          } finally {
            await db.execute(sql`drop trigger synthetic_handback_failure on agent_wakeup_requests`);
            await db.execute(sql`drop function synthetic_handback_failure()`);
          }
        }
        const response = await resolve();
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        expect(response.body.recoveryAction).toMatchObject({ status: "resolved", outcome: "handed_back" });
        expect((await resolve()).status).toBe(200);
        expect(execution).toHaveBeenCalledTimes(1);
        finishRepair();
        await vi.waitFor(() => expect(execution).toHaveBeenCalledTimes(2), { timeout: 10000 });
        await heartbeat.drainActiveRunExecutions();
        const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId));
        expect(runs).toHaveLength(2);
        const successor = runs.find(run => run.id !== repair!.id)!;
        expect(successor).toMatchObject({ status: "succeeded", contextSnapshot: { forceFreshSession: true,
          wakeReason: "issue_recovery_action_restored" } });
        expect(successor.contextSnapshot).not.toHaveProperty("dispositionRecoveryActionId");
        expect((await resolve()).status).toBe(200);
        await heartbeatService(db).dispatchPendingNativeStatusWakeups({ companyId: f.companyId });
        expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(2);
        expect(await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, f.companyId),
          eq(agentWakeupRequests.requestedByActorId, "owner-disposition-handback")))).toHaveLength(1);
      } finally { finishRepair(); await heartbeat.drainActiveRunExecutions(); execution.mockRestore(); }
    }, 45000);
  it("does not deliver a rejected reset commit", async () => {
    const f = await seed();
    const preview = (await inspectExecutionReset(db, f.companyId, f.issueId))!;
    const intent = { companyId: f.companyId, issueId: f.issueId, principalId: "board", idempotencyKey: "rejected-delivery",
      expectedHoldingRunId: f.sourceRunId, expectedRecoveryActionId: preview.holds[0].recoveryActionId,
      fingerprint: preview.fingerprint, acknowledgeFreshHistoryAwareTurn: true as const };
    const publish = vi.fn(), start = vi.fn(), failed = vi.fn();
    await expect(deliverExecutionReset(db, intent, () => heartbeatService(db).commitBoardExecutionReset(intent),
      { publish, start, failed })).rejects.toThrow("execution_reset_admission_rejected");
    expect(publish).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled(); expect(failed).not.toHaveBeenCalled();
  });
  it("inspects every hold, preserves unknown IDs and invalidates changed evidence without mutation", async () => {
    const f = await seed();
    const inventory = { schema: "paperclip.execution-actions.v1", source: "acp", complete: true,
      dispatch: "attempted", noActionsConfirmed: false,
      actions: [{ id: "retained-action", kind: "edit", status: "completed", outcome: "completed" }] };
    await db.update(heartbeatRuns).set({ resultJson: {
      executionActionInventory: inventory, providerPrivateData: "must-not-appear",
    } }).where(eq(heartbeatRuns.id, f.sourceRunId));
    const first = await inspectExecutionReset(db, f.companyId, f.issueId);
    expect(first?.holds).toHaveLength(1);
    expect(first?.holds[0]).toMatchObject({ holdingRunId: f.sourceRunId,
      outcomeClassification: "settled", unknownActionIds: [], evidenceIncomplete: false });
    expect(JSON.stringify(first)).not.toContain("must-not-appear");
    expect((await inspectExecutionReset(db, f.companyId, f.issueId))?.fingerprint).toBe(first?.fingerprint);
    expect(await inspectExecutionReset(db, randomUUID(), f.issueId)).toBeNull();
    const foreign = await seed();
    await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.issueId,
      kind: "active_run_watchdog", cause: "uncertain_external_action", fingerprint: randomUUID(),
      status: "active", nextAction: "Inspect", evidence: { runId: foreign.sourceRunId } });
    const added = await inspectExecutionReset(db, f.companyId, f.issueId);
    expect(added?.holds).toHaveLength(2);
    expect(added?.fingerprint).not.toBe(first?.fingerprint);
    expect(added?.holds.find(hold => hold.holdingRunId === foreign.sourceRunId)).toMatchObject({
      sourceAvailable: false, outcomeClassification: "unknown", runStatus: null });
    await db.update(heartbeatRuns).set({ resultJson: {
      executionActionInventory: { ...inventory, complete: false },
    } }).where(eq(heartbeatRuns.id, f.sourceRunId));
    const changed = await inspectExecutionReset(db, f.companyId, f.issueId);
    expect(changed?.fingerprint).not.toBe(added?.fingerprint);
    expect(changed?.holds.find(hold => hold.holdingRunId === f.sourceRunId)).toMatchObject({
      outcomeClassification: "unknown", unknownActionIds: ["retained-action"], evidenceIncomplete: true });
    const leaseId = randomUUID();
    await db.insert(environmentLeases).values({ id: leaseId, companyId: f.companyId,
      issueId: f.issueId, heartbeatRunId: f.sourceRunId, provider: "local", status: "released",
      releasedAt: new Date(), cleanupStatus: "completed" });
    const leased = await inspectExecutionReset(db, f.companyId, f.issueId);
    expect(leased?.fingerprint).not.toBe(changed?.fingerprint);
    await db.update(nativeRunFinalizations).set({ controllerGeneration: 1 }).where(eq(nativeRunFinalizations.runId, f.sourceRunId));
    expect((await inspectExecutionReset(db, f.companyId, f.issueId))?.fingerprint).not.toBe(leased?.fingerprint);
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).not.toBeNull();
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.sourceRunId)))[0].resultJson)
      .toEqual({ executionActionInventory: { ...inventory, complete: false } });
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toHaveLength(0);
  });

  it.each(["settled", "operator stop", "unknown", "stale fingerprint", "wrong holding run", "wrong recovery", "agent actor", "missing acknowledgment", "pause", "review", "approval", "dependency", "paused agent", "missing process", "unsafe hold", "issue lease", "conflicting claim", "rollback"] as const)(
    "admits only safe fingerprint-bound board reset (%s)", async state => {
      const f = await seed();
      const inventory = { schema: "paperclip.execution-actions.v1", source: "acp", complete: true,
        dispatch: "attempted", noActionsConfirmed: false,
        actions: [{ id: "reset-original-effect", kind: "edit", status: "completed", outcome: state === "unknown" ? "unknown" : "completed" }] };
      const resultJson = { executionActionInventory: inventory,
        ...(state === "operator stop" ? { cancellation: { source: "operator", expected: true,
          initiator: { type: "user" }, reason: "Stop", recordedAt: new Date().toISOString() } } : {}) };
      await db.update(heartbeatRuns).set({ resultJson,
        processPid: state === "missing process" ? null : 999999999,
      }).where(eq(heartbeatRuns.id, f.sourceRunId));
      if (state === "pause") await db.insert(issueTreeHolds).values({ companyId: f.companyId, rootIssueId: f.issueId, mode: "pause" });
      if (state === "review") await db.update(issues).set({ executionState: { status: "pending", currentStageType: "review" } }).where(eq(issues.id, f.issueId));
      if (state === "paused agent") await db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.agentId));
      if (state === "approval") {
        const id = randomUUID();
        await db.insert(approvals).values({ id, companyId: f.companyId, type: "request_board_approval", status: "pending", payload: {} });
        await db.insert(issueApprovals).values({ companyId: f.companyId, issueId: f.issueId, approvalId: id });
      }
      if (state === "dependency") {
        const id = randomUUID();
        await db.insert(issues).values({ id, companyId: f.companyId, title: "Open input", status: "todo" });
        await db.insert(issueRelations).values({ companyId: f.companyId, issueId: id, relatedIssueId: f.issueId, type: "blocks" });
      }
      if (state === "unsafe hold") await db.insert(issueRecoveryActions).values({ companyId: f.companyId,
        sourceIssueId: f.issueId, kind: "active_run_watchdog", cause: "uncertain_external_action",
        fingerprint: randomUUID(), status: "active", nextAction: "Inspect", evidence: { runId: randomUUID() } });
      if (state === "issue lease") await db.insert(environmentLeases).values({ companyId: f.companyId,
        issueId: f.issueId, provider: "local", status: "active" });
      if (state === "conflicting claim") {
        const id = randomUUID();
        await db.insert(heartbeatRuns).values({ id, companyId: f.companyId, agentId: f.agentId, status: "failed", finishedAt: new Date(), contextSnapshot: { issueId: randomUUID() } });
        await db.update(issues).set({ checkoutRunId: id }).where(eq(issues.id, f.issueId));
      }
      const inspection = (await inspectExecutionReset(db, f.companyId, f.issueId))!;
      const recovery = inspection.holds.find(hold => hold.holdingRunId === f.sourceRunId)!;
      const input = { ...f, db, reason: "execution_reset", commentId: null,
        actorType: state === "agent actor" ? "agent" : "user", resetId: randomUUID(),
        expectedHoldingRunId: state === "wrong holding run" ? randomUUID() : f.sourceRunId,
        expectedRecoveryActionId: state === "wrong recovery" ? randomUUID() : recovery.recoveryActionId,
        fingerprint: state === "stale fingerprint" ? "stale" : inspection.fingerprint,
        acknowledgeFreshHistoryAwareTurn: state !== "missing acknowledgment" };
      const admitted = await db.transaction(tx => admitBoardExecutionReset({ ...input, db: tx as unknown as typeof db, dryRun: true }));
      expect(await getExecutionBlocker(db, f.companyId, f.issueId)).not.toBeNull();
      if (!["settled", "operator stop", "rollback"].includes(state)) { expect(admitted).toBeNull(); return; }
      expect(admitted).toMatchObject({ previousRunId: f.sourceRunId, commentId: null });
      const commit = () => db.transaction(async tx => {
        expect(await admitBoardExecutionReset({ ...input, db: tx as unknown as typeof db })).not.toBeNull();
        if (state === "rollback") throw new Error("synthetic reset outbox failure");
        await tx.insert(heartbeatRuns).values({ id: f.successorRunId, companyId: f.companyId, agentId: f.agentId,
          status: "queued", contextSnapshot: { issueId: f.issueId, previousRunId: f.sourceRunId, forceFreshSession: true } });
      });
      if (state === "rollback") {
        await expect(commit()).rejects.toThrow("synthetic reset outbox failure");
        expect(await getExecutionBlocker(db, f.companyId, f.issueId)).not.toBeNull();
      } else {
        await commit();
        expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
        const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, recovery.recoveryActionId));
        expect(action.evidence.boardExecutionReset).toMatchObject({ resetId: input.resetId,
          fingerprint: inspection.fingerprint, actorId: "board", runId: f.successorRunId });
        expect(action.evidence.explicitUserContinuation).toBeUndefined();
        expect(action.evidence.dependencyClosureContinuation).toBeUndefined();
      }
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.sourceRunId)))[0].resultJson).toEqual(resultJson);
    });

  it("lists historical effective execution holds for board resolution", async () => {
    const f = await seed();
    const [hold] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    await db.update(issueRecoveryActions).set({ cause: "legacy_execution_requires_reconciliation",
      evidence: { runId: f.sourceRunId, automaticRecovery: { replay: "blocked" } } }).where(eq(issueRecoveryActions.id, hold.id));
    const foreign = await seed();
    await db.insert(authUsers).values({ id: "board", name: "Synthetic board", email: "board@reset.test",
      createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
    await db.insert(companyMemberships).values({ companyId: f.companyId, principalType: "user",
      principalId: "board", status: "active", membershipRole: "admin" });
    const app = express();
    app.use((req, _res, next) => {
      req.actor = { type: "board", userId: "board", companyIds: [f.companyId],
        memberships: [{ companyId: f.companyId, status: "active", membershipRole: "admin" }],
        isInstanceAdmin: false, source: "session" };
      next();
    });
    app.use("/api", issueRoutes(db, {} as any)); app.use(errorHandler);
    const response = await request(app).get(`/api/issues/${f.issueId}/recovery-actions`);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.actions).toContainEqual(expect.objectContaining({ id: hold.id,
      cause: "legacy_execution_requires_reconciliation", evidence: expect.objectContaining({ runId: f.sourceRunId }) }));
    expect(response.body.actions.every((action: { sourceIssueId: string }) => action.sourceIssueId === f.issueId)).toBe(true);
    expect((await request(app).get(`/api/issues/${foreign.issueId}/recovery-actions`)).status).toBe(404);
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).not.toBeNull();
  });

  it.each(["local", "daytona"] as const)("board reset requires canonical released lease cleanup (%s)", async provider => {
    for (const cleanupStatus of ["success", "completed", "failed", null]) {
      const f = await seed();
      const resultJson = { executionActionInventory: {
        schema: "paperclip.execution-actions.v1", source: "acp", complete: true,
        dispatch: "attempted", noActionsConfirmed: false,
        actions: [{ id: "lease-original-effect", kind: "edit", status: "completed", outcome: "completed" }],
      } };
      await db.update(heartbeatRuns).set({ resultJson, processPid: provider === "local" ? 999999999 : process.pid })
        .where(eq(heartbeatRuns.id, f.sourceRunId));
      const [environment] = await db.insert(environments).values({ name: `Reset ${f.sourceRunId}`, driver: "sandbox" }).returning();
      const identity = { id: randomUUID(), companyId: f.companyId, heartbeatRunId: f.sourceRunId,
        provider, providerLeaseId: "reset-sandbox" };
      await db.insert(environmentLeases).values({ ...identity, environmentId: environment.id, issueId: f.issueId,
        status: "released", leasePolicy: "ephemeral", releasedAt: new Date(), cleanupStatus,
        metadata: provider === "local" ? {} : { remoteExecutionTermination:
          remoteTerminationReceipt(identity, { providerLeaseId: identity.providerLeaseId, state: "stopped" }) },
      });
      const inspection = (await inspectExecutionReset(db, f.companyId, f.issueId))!;
      const input = { ...f, db, reason: "execution_reset", commentId: null, resetId: randomUUID(),
        expectedHoldingRunId: f.sourceRunId, expectedRecoveryActionId: inspection.holds[0].recoveryActionId,
        fingerprint: inspection.fingerprint, acknowledgeFreshHistoryAwareTurn: true };
      const eligible = cleanupStatus === "success";
      expect(Boolean(await db.transaction(tx => admitBoardExecutionReset({ ...input, db: tx as unknown as typeof db, dryRun: true })))).toBe(eligible);
      expect(await getExecutionBlocker(db, f.companyId, f.issueId)).not.toBeNull();
      await db.transaction(async tx => {
        const admitted = await admitBoardExecutionReset({ ...input, db: tx as unknown as typeof db });
        expect(Boolean(admitted)).toBe(eligible);
        if (admitted) await tx.insert(heartbeatRuns).values({ id: f.successorRunId, companyId: f.companyId,
          agentId: f.agentId, status: "queued", contextSnapshot: { issueId: f.issueId, previousRunId: f.sourceRunId, forceFreshSession: true } });
      });
      expect(Boolean(await getExecutionBlocker(db, f.companyId, f.issueId))).toBe(!eligible);
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(eligible ? 2 : 1);
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.sourceRunId)))[0].resultJson).toEqual(resultJson);
    }
  });

  it.each(["valid", "missing context", "reset ID", "fingerprint", "actor", "holding run", "recovery ID",
    "successor", "fresh session", "saved context", "unknown ledger", "missing receipt", "acknowledgment", "missing request", "request actor", "request fingerprint", "request successor", "request company"] as const)(
    "validates board reset authorization before dispatch (%s)", async state => {
      const f = await seed();
      await db.update(heartbeatRuns).set({ resultJson: { executionActionInventory: {
        schema: "paperclip.execution-actions.v1", source: "acp", complete: true,
        dispatch: "attempted", noActionsConfirmed: false,
        actions: [{ id: "dispatch-original-effect", kind: "edit", status: "completed", outcome: "completed" }],
      } } }).where(eq(heartbeatRuns.id, f.sourceRunId));
      const inspection = (await inspectExecutionReset(db, f.companyId, f.issueId))!;
      const recoveryId = inspection.holds[0].recoveryActionId;
      const reset = { resetId: randomUUID(), fingerprint: inspection.fingerprint, actorId: "board",
        expectedHoldingRunId: f.sourceRunId, expectedRecoveryActionId: recoveryId,
        previousRunId: f.sourceRunId };
      const context: Record<string, unknown> = { issueId: f.issueId, previousRunId: f.sourceRunId,
        forceFreshSession: true, boardExecutionReset: reset };
      await db.transaction(async tx => {
        expect(await admitBoardExecutionReset({ ...f, db: tx as unknown as typeof db,
          ...reset, reason: "execution_reset", commentId: null, acknowledgeFreshHistoryAwareTurn: true })).not.toBeNull();
        await tx.insert(heartbeatRuns).values({ id: f.successorRunId, companyId: f.companyId,
          agentId: f.agentId, status: "queued", contextSnapshot: context });
        if (state !== "missing request") await tx.insert(agentWakeupRequests).values({
          id: reset.resetId, companyId: state === "request company" ? (await seed()).companyId : f.companyId,
          agentId: f.agentId, source: "on_demand", triggerDetail: "system", reason: "execution_reset",
          status: "coalesced", runId: state === "request successor" ? f.sourceRunId : f.successorRunId,
          requestedByActorType: "user", requestedByActorId: state === "request actor" ? "other-user" : "board",
          idempotencyKey: `synthetic-reset:${reset.resetId}`,
          payload: { issueId: f.issueId, boardExecutionReset: { ...reset,
            ...(state === "request fingerprint" ? { fingerprint: "forged" } : {}),
            acknowledgeFreshHistoryAwareTurn: true } },
        });
      });
      const altered = { ...reset };
      if (state === "missing context") delete context.boardExecutionReset;
      if (state === "reset ID") altered.resetId = randomUUID();
      if (state === "fingerprint") altered.fingerprint = "forged";
      if (state === "actor") altered.actorId = "different-board-user";
      if (state === "holding run") altered.expectedHoldingRunId = randomUUID();
      if (state === "recovery ID") altered.expectedRecoveryActionId = randomUUID();
      if (state !== "missing context") context.boardExecutionReset = altered;
      if (state === "fresh session") context.forceFreshSession = false;
      if (state === "saved context") await db.update(heartbeatRuns).set({ contextSnapshot: {
        ...context, boardExecutionReset: { ...reset, resetId: randomUUID() },
      } }).where(eq(heartbeatRuns.id, f.successorRunId));
      if (state === "unknown ledger") await db.update(heartbeatRuns).set({ resultJson: {} }).where(eq(heartbeatRuns.id, f.sourceRunId));
      if (["missing receipt", "acknowledgment"].includes(state)) {
        const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, recoveryId));
        const receipt = action.evidence.boardExecutionReset as Record<string, unknown>;
        await db.update(issueRecoveryActions).set({ evidence: { ...action.evidence,
          boardExecutionReset: state === "missing receipt" ? null : { ...receipt, acknowledgeFreshHistoryAwareTurn: false },
        } }).where(eq(issueRecoveryActions.id, recoveryId));
      }
      const dispatch = buildExecutionContinuation({ db, companyId: f.companyId, issueId: f.issueId,
        agentId: f.agentId, runId: state === "successor" ? randomUUID() : f.successorRunId,
        context, summary: null, exposeLowTrustRaw: false });
      if (state === "valid") expect((await dispatch).completedActions).toContainEqual({
        runId: f.sourceRunId, receiptId: "dispatch-original-effect", operationId: "acp:edit",
        result: { status: "completed", outcome: "completed" },
      });
      else await expect(dispatch).rejects.toThrow("continuation_board_reset_authorization_missing");
    });

  it.each(["reset", "closure"] as const)("serializes board reset against another %s", async competing => {
    const f = await seed();
    await db.update(heartbeatRuns).set({ resultJson: { executionActionInventory: {
      schema: "paperclip.execution-actions.v1", source: "acp", complete: true,
      dispatch: "attempted", noActionsConfirmed: false,
      actions: [{ id: "race-effect", kind: "edit", status: "completed", outcome: "completed" }],
    } } }).where(eq(heartbeatRuns.id, f.sourceRunId));
    const blockerId = randomUUID();
    await db.insert(issues).values({ id: blockerId, companyId: f.companyId, title: "Closed", status: "done", completedAt: new Date() });
    await db.insert(issueRelations).values({ companyId: f.companyId, issueId: blockerId, relatedIssueId: f.issueId, type: "blocks" });
    const receiptId = await recordDependencyClosureProof(db, { ...f, resolvedBlockerIssueId: blockerId, producer: "issue_update" });
    const inspection = (await inspectExecutionReset(db, f.companyId, f.issueId))!;
    const input = { ...f, commentId: null, reason: "execution_reset", resetId: randomUUID(),
      expectedHoldingRunId: f.sourceRunId, expectedRecoveryActionId: inspection.holds[0].recoveryActionId,
      fingerprint: inspection.fingerprint, acknowledgeFreshHistoryAwareTurn: true };
    const attempt = (other: boolean) => db.transaction(async tx => {
      await tx.select({ id: issues.id }).from(issues).where(and(eq(issues.companyId, f.companyId), eq(issues.id, f.issueId))).for("update");
      const successorRunId = randomUUID();
      const admitted = other && competing === "closure"
        ? await admitDependencyClosureContinuation({ ...f, db: tx as unknown as typeof db, actorType: "system", actorId: "issue-dependencies", reason: "issue_blockers_resolved", commentId: null, receiptId, successorRunId })
        : await admitBoardExecutionReset({ ...input, db: tx as unknown as typeof db, resetId: randomUUID(), successorRunId });
      if (!admitted) return false;
      await tx.insert(heartbeatRuns).values({ id: successorRunId, companyId: f.companyId, agentId: f.agentId,
        status: "queued", contextSnapshot: { issueId: f.issueId, previousRunId: f.sourceRunId, forceFreshSession: true } });
      return true;
    });
    const results = await Promise.all([attempt(false), attempt(true)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.status, "queued")))).toHaveLength(1);
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
  });

  it.each(["settled", "unknown", "forged", "operator stop", "missing process", "live process", "live controller", "second unsafe hold", "approval", "pause", "review", "action workspace", "closure predates stop", "rollback"] as const)(
    "admits only a fully settled trusted closure (%s)", async state => {
      const f = await seed();
      const blockerId = randomUUID();
      await db.insert(issues).values({ id: blockerId, companyId: f.companyId, title: "Review",
        status: "done", completedAt: new Date("2026-09-11T12:00:00Z") });
      await db.insert(issueRelations).values({ companyId: f.companyId,
        issueId: blockerId, relatedIssueId: f.issueId, type: "blocks" });
      const receiptId = await recordDependencyClosureProof(db, { ...f,
        resolvedBlockerIssueId: blockerId, producer: "issue_update" });
      const inventory = { schema: "paperclip.execution-actions.v1", source: "acp", complete: true,
        dispatch: "attempted", noActionsConfirmed: false,
        actions: [{ id: "original-effect-id", kind: "edit", status: "completed", outcome: "completed" }] };
      const resultJson = { executionActionInventory: state === "unknown"
        ? { ...inventory, actions: [{ ...inventory.actions[0], outcome: "unknown" }] } : inventory,
        ...(state === "operator stop" ? { cancellation: { source: "operator", expected: true,
          initiator: { type: "user" }, reason: "Stop", recordedAt: new Date().toISOString() } } : {}) };
      await db.update(heartbeatRuns).set({ resultJson,
        processPid: state === "missing process" ? null : state === "live process" ? process.pid : 999999999,
        ...(state === "live controller" ? { controllerLeaseExpiresAt: new Date(Date.now() + 60_000) } : {}),
      }).where(eq(heartbeatRuns.id, f.sourceRunId));
      if (state === "second unsafe hold") await db.insert(issueRecoveryActions).values({
        companyId: f.companyId, sourceIssueId: f.issueId, kind: "active_run_watchdog",
        cause: "uncertain_external_action", fingerprint: randomUUID(), status: "active",
        nextAction: "Inspect missing source", evidence: { runId: randomUUID() },
      });
      if (state === "approval") {
        const id = randomUUID();
        await db.insert(approvals).values({ id, companyId: f.companyId, type: "request_board_approval", status: "pending", payload: {} });
        await db.insert(issueApprovals).values({ companyId: f.companyId, issueId: f.issueId, approvalId: id });
      }
      if (state === "pause") await db.insert(issueTreeHolds).values({ companyId: f.companyId, rootIssueId: f.issueId, mode: "pause" });
      if (state === "review") await db.update(issues).set({ executionState: { status: "pending", currentStageType: "review" } }).where(eq(issues.id, f.issueId));
      if (state === "action workspace") await db.update(issueRecoveryActions).set({ evidence: {
        runId: f.sourceRunId, workspaceRestoreFailure: "restore_unsafe_archive", automaticRecovery: { replay: "blocked" },
      } }).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
      if (state === "closure predates stop") await db.update(heartbeatRuns).set({ finishedAt: new Date(Date.now() + 60_000) }).where(eq(heartbeatRuns.id, f.sourceRunId));
      const input = { ...f, db, actorType: "agent", actorId: f.agentId,
        reason: "issue_blockers_resolved", commentId: null,
        receiptId: state === "forged" ? randomUUID() : receiptId };
      const dry = await db.transaction(tx => admitDependencyClosureContinuation({ ...input, db: tx as unknown as typeof db, dryRun: true }));
      expect(await getExecutionBlocker(db, f.companyId, f.issueId)).not.toBeNull();
      if (!["settled", "rollback"].includes(state)) { expect(dry).toBeNull(); return; }
      expect(dry).toMatchObject({ previousRunId: f.sourceRunId, commentId: null });
      const commit = () => db.transaction(async tx => {
        const admitted = await admitDependencyClosureContinuation({ ...input, db: tx as unknown as typeof db });
        expect(admitted).toMatchObject({ previousRunId: f.sourceRunId });
        if (state === "rollback") throw new Error("synthetic successor insertion failure");
        await tx.insert(heartbeatRuns).values({ id: f.successorRunId, companyId: f.companyId,
          agentId: f.agentId, status: "queued", contextSnapshot: { issueId: f.issueId,
            previousRunId: f.sourceRunId, forceFreshSession: true, dependencyClosureContinuation: { ...admitted, receiptId } } });
      });
      if (state === "rollback") {
        await expect(commit()).rejects.toThrow("synthetic successor insertion failure");
        expect(await getExecutionBlocker(db, f.companyId, f.issueId)).not.toBeNull();
      } else {
        await commit();
        await buildExecutionContinuation({ db, companyId: f.companyId, issueId: f.issueId, agentId: f.agentId,
          runId: f.successorRunId, context: { issueId: f.issueId, previousRunId: f.sourceRunId,
            dependencyClosureContinuation: { previousRunId: f.sourceRunId, receiptId } }, summary: null, exposeLowTrustRaw: false });
        await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.successorRunId));
        expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
        const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
        expect(action!.evidence.dependencyClosureContinuation).toMatchObject({ receiptId, runId: f.successorRunId });
        expect(action!.evidence.explicitUserContinuation).toBeUndefined();
        expect(await db.transaction(tx => admitDependencyClosureContinuation({ ...input, db: tx as unknown as typeof db }))).toBeNull();
      }
      const [source] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.sourceRunId));
      expect(source!.resultJson).toEqual(resultJson);
    });

  it.each(["stopped", "destroyed", "missing", "wrong_lease", "cleanup_failed", "active"] as const)(
    "dependency closure requires bound remote termination (%s)", async kind => {
      const f = await seed();
      const resultJson = { executionActionInventory: {
        schema: "paperclip.execution-actions.v1", source: "acp", complete: true,
        dispatch: "attempted", noActionsConfirmed: false,
        actions: [{ id: "remote-original-effect", kind: "edit", status: "completed", outcome: "completed" }],
      } };
      await db.update(heartbeatRuns).set({ resultJson, processPid: process.pid }).where(eq(heartbeatRuns.id, f.sourceRunId));
      const [environment] = await db.insert(environments).values({ name: `Closure ${f.sourceRunId}`, driver: "sandbox" }).returning();
      const identity = { id: randomUUID(), companyId: f.companyId, heartbeatRunId: f.sourceRunId,
        provider: "daytona", providerLeaseId: "closure-sandbox" };
      const proof = remoteTerminationReceipt(identity, { providerLeaseId: identity.providerLeaseId,
        state: kind === "destroyed" ? "destroyed" : "stopped" });
      await db.insert(environmentLeases).values({ ...identity, environmentId: environment.id, issueId: f.issueId,
        status: kind === "active" ? "active" : "released", leasePolicy: "ephemeral",
        releasedAt: kind === "active" ? null : new Date(), cleanupStatus: kind === "cleanup_failed" ? "failed" : "success",
        metadata: kind === "missing" ? {} : { remoteExecutionTermination:
          kind === "wrong_lease" ? { ...proof, providerLeaseId: "another-sandbox" } : proof },
      });
      const blockerId = randomUUID();
      await db.insert(issues).values({ id: blockerId, companyId: f.companyId, title: "Review", status: "done", completedAt: new Date() });
      await db.insert(issueRelations).values({ companyId: f.companyId, issueId: blockerId, relatedIssueId: f.issueId, type: "blocks" });
      const receiptId = await recordDependencyClosureProof(db, { ...f, resolvedBlockerIssueId: blockerId, producer: "issue_update" });
      const input = { ...f, db, actorType: "system", actorId: "issue-dependencies", reason: "issue_blockers_resolved", commentId: null, receiptId };
      const eligible = kind === "stopped" || kind === "destroyed";
      const dry = await db.transaction(tx => admitDependencyClosureContinuation({ ...input, db: tx as unknown as typeof db, dryRun: true }));
      expect(Boolean(dry)).toBe(eligible);
      expect(await getExecutionBlocker(db, f.companyId, f.issueId)).not.toBeNull();
      await db.transaction(async tx => {
        const admitted = await admitDependencyClosureContinuation({ ...input, db: tx as unknown as typeof db });
        expect(Boolean(admitted)).toBe(eligible);
        if (admitted) await tx.insert(heartbeatRuns).values({ id: f.successorRunId, companyId: f.companyId, agentId: f.agentId,
          status: "queued", contextSnapshot: { issueId: f.issueId, previousRunId: f.sourceRunId, forceFreshSession: true,
            dependencyClosureContinuation: { ...admitted, receiptId } } });
      });
      if (eligible) {
        const [successor] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.successorRunId));
        const envelope = await buildExecutionContinuation({ db, companyId: f.companyId, issueId: f.issueId, agentId: f.agentId,
          runId: f.successorRunId, context: successor.contextSnapshot!, summary: null, exposeLowTrustRaw: false });
        expect(envelope.completedActions).toContainEqual({ runId: f.sourceRunId, receiptId: "remote-original-effect",
          operationId: "acp:edit", result: { status: "completed", outcome: "completed" } });
        expect(await db.transaction(tx => admitDependencyClosureContinuation({ ...input, db: tx as unknown as typeof db }))).toBeNull();
      } else expect(await getExecutionBlocker(db, f.companyId, f.issueId)).not.toBeNull();
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(eligible ? 2 : 1);
      const [source] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.sourceRunId));
      expect(source.resultJson).toEqual(resultJson);
    });

  it.each((["system", "agent", "user"] as const).flatMap(actorType => [{ actorType, deferred: false }, { actorType, deferred: true }]))("queues one settled legacy closure preserving $actorType actor (deferred=$deferred)", async ({ actorType, deferred }) => {
    const f = await seed();
    await db.delete(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.sourceRunId));
    await db.update(agents).set({ adapterType: "codex_local" }).where(eq(agents.id, f.agentId));
    const resultJson = { executionActionInventory: { schema: "paperclip.execution-actions.v1", source: "acp", complete: true,
      dispatch: "attempted", noActionsConfirmed: false,
      actions: [{ id: "original-write", kind: "edit", status: "completed", outcome: "completed" }] } };
    await db.update(heartbeatRuns).set({ runtimeMode: "legacy", nativeIssueId: null, status: "failed",
      runnerProfileJson: { adapterDispatch: { adapterType: "codex_local" } }, resultJson,
    }).where(eq(heartbeatRuns.id, f.sourceRunId));
    await db.update(issueRecoveryActions).set({ cause: "legacy_execution_requires_reconciliation" })
      .where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    const blockerId = randomUUID();
    await db.insert(issues).values({ id: blockerId, companyId: f.companyId, title: "Review",
      status: "done", completedAt: new Date("2026-09-11T12:00:00Z") });
    await db.insert(issueRelations).values({ companyId: f.companyId, issueId: blockerId, relatedIssueId: f.issueId, type: "blocks" });
    const receiptId = await recordDependencyClosureProof(db, { ...f, resolvedBlockerIssueId: blockerId, producer: "issue_update" });
    const occupied = randomUUID();
    await db.insert(heartbeatRuns).values({ id: occupied, companyId: f.companyId, agentId: f.agentId,
      status: "running", startedAt: new Date(), contextSnapshot: {} });
    const heartbeat = heartbeatService(db);
    try {
      const options = { source: "automation" as const, triggerDetail: "system" as const, reason: "issue_blockers_resolved",
        requestedByActorType: actorType, requestedByActorId: actorType === "user" ? "board" : f.agentId,
        payload: { issueId: f.issueId, dependencyClosureReceiptId: receiptId }, contextSnapshot: { issueId: f.issueId },
        idempotencyKey: `synthetic-closure:${receiptId}` };
      let successor;
      if (deferred) {
        await db.update(heartbeatRuns).set({ resultJson: { executionActionInventory: {
          ...resultJson.executionActionInventory, actions: [{ id: "original-write", kind: "edit", status: "failed", outcome: "unknown" }],
        } } }).where(eq(heartbeatRuns.id, f.sourceRunId));
        expect(await heartbeat.wakeup(f.agentId, options)).toBeNull();
        const [saved] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId));
        expect(saved!.payload?.executionWait).toMatchObject({ reason: "unknown_action_outcomes" });
        expect(saved!.requestedByActorType).toBe(actorType);
        await db.update(heartbeatRuns).set({ resultJson }).where(eq(heartbeatRuns.id, f.sourceRunId));
        await db.update(agentWakeupRequests).set({ updatedAt: new Date(Date.now() - 60_000) }).where(eq(agentWakeupRequests.id, saved!.id));
        await heartbeat.resumeQueuedRuns();
        const [adopted] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, saved!.id));
        expect(adopted).toMatchObject({ status: "coalesced" });
        [successor] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, adopted!.runId!));
      } else successor = await heartbeat.wakeup(f.agentId, options);
      expect(successor).not.toBeNull();
      expect(successor!.status).toBe("queued");
      expect(successor!.contextSnapshot).toMatchObject({ previousRunId: f.sourceRunId, forceFreshSession: true,
        dependencyClosureContinuation: { receiptId, previousRunId: f.sourceRunId } });
      expect(successor!.contextSnapshot?.explicitUserContinuation).toBeUndefined();
      expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
      const envelope = await buildExecutionContinuation({ db, companyId: f.companyId, issueId: f.issueId, agentId: f.agentId,
        runId: successor!.id, context: successor!.contextSnapshot!, summary: null, exposeLowTrustRaw: false });
      expect(envelope.completedActions).toContainEqual({ runId: f.sourceRunId, receiptId: "original-write",
        operationId: "acp:edit", result: { status: "completed", outcome: "completed" } });
      await heartbeat.wakeup(f.agentId, options);
      const runs = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId),
        sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${f.issueId}`));
      expect(runs).toHaveLength(2);
      const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.runId, successor!.id));
      expect(wake!.requestedByActorType).toBe(actorType);
      const [source] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.sourceRunId));
      expect(source!.resultJson).toEqual(resultJson);
      await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, successor!.id));
      const repeated = await heartbeat.wakeup(f.agentId, { ...options, idempotencyKey: `different-key:${receiptId}` });
      expect(repeated!.id).toBe(successor!.id);
      expect(await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId),
        sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${f.issueId}`))).toHaveLength(2);
    } finally {
      await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(eq(heartbeatRuns.id, occupied));
    }
  });

  it.each(["valid", "forged reason", "wrong company", "wrong issue", "owner changed", "blocker reopened", "cancelled blocker", "edge recreated", "new blocker", "new cycle"] as const)(
    "validates server dependency provenance against current state (%s)", async state => {
      const f = await seed();
      const blockerId = randomUUID();
      await db.insert(issues).values({ id: blockerId, companyId: f.companyId, title: "Review",
        status: "done", completedAt: new Date("2026-09-11T12:00:00Z") });
      await db.insert(issueRelations).values({ companyId: f.companyId,
        issueId: blockerId, relatedIssueId: f.issueId, type: "blocks" });
      const receiptId = await recordDependencyClosureProof(db, { ...f,
        resolvedBlockerIssueId: blockerId, producer: "issue_update" });
      expect(receiptId).not.toBeNull();
      const scope = { companyId: f.companyId, issueId: f.issueId, agentId: f.agentId,
        receiptId: state === "forged reason" ? randomUUID() : receiptId };
      if (state === "wrong company") scope.companyId = randomUUID();
      if (state === "wrong issue") scope.issueId = randomUUID();
      if (state === "owner changed") await db.update(issues).set({ assigneeAgentId: null }).where(eq(issues.id, f.issueId));
      if (state === "blocker reopened" || state === "cancelled blocker") await db.update(issues)
        .set({ status: state === "cancelled blocker" ? "cancelled" : "in_progress" }).where(eq(issues.id, blockerId));
      if (state === "edge recreated") {
        await db.delete(issueRelations).where(eq(issueRelations.relatedIssueId, f.issueId));
        await db.insert(issueRelations).values({ companyId: f.companyId,
          issueId: blockerId, relatedIssueId: f.issueId, type: "blocks" });
      }
      if (state === "new blocker") {
        const newBlockerId = randomUUID();
        await db.insert(issues).values({ id: newBlockerId, companyId: f.companyId, title: "Additional review", status: "todo" });
        await db.insert(issueRelations).values({ companyId: f.companyId,
          issueId: newBlockerId, relatedIssueId: f.issueId, type: "blocks" });
      }
      if (state === "new cycle") await db.update(issues).set({ blockedTransitionAt: new Date() }).where(eq(issues.id, f.issueId));
      const verified = await verifyDependencyClosureProof(db, scope);
      if (state === "valid") expect(verified).toMatchObject({ receiptId, resolvedBlockerIssueId: blockerId });
      else expect(verified).toBeNull();
      // Provenance is evidence only; it never mutates execution or recovery.
      expect(await getExecutionBlocker(db, f.companyId, f.issueId)).not.toBeNull();
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(1);
    });

  it.each(["settled", "unknown"])("retains blocker-close wake behind unproven stopped recovery (%s)", async outcome => {
    const f = await seed();
    await db.delete(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.sourceRunId));
    await db.update(agents).set({ adapterType: "codex_local" }).where(eq(agents.id, f.agentId));
    await db.update(heartbeatRuns).set({ runtimeMode: "legacy", status: "cancelled", resultJson: {
      executionRecovery: { kind: "interrupted", providerStopped: true, sessionPreserved: true, actionOutcomes: outcome },
      executionCancellation: { state: "acknowledged" },
    } }).where(eq(heartbeatRuns.id, f.sourceRunId));
    await db.update(issueRecoveryActions).set({ cause: "legacy_execution_requires_reconciliation", evidence: {
      runId: f.sourceRunId, automaticRecovery: { replay: "blocked", actionOutcome: outcome },
    } }).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    const result = await heartbeatService(db).wakeup(f.agentId, {
      source: "automation", triggerDetail: "system", reason: "issue_blockers_resolved",
      requestedByActorType: "system", requestedByActorId: "issue-dependencies",
      payload: { issueId: f.issueId }, contextSnapshot: { issueId: f.issueId },
    });
    expect(result).toBeNull();
    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId));
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({
      reason: "issue_blockers_resolved", status: "deferred_issue_execution", runId: null,
      requestedByActorType: "system", requestedByActorId: "issue-dependencies",
      payload: { issueId: f.issueId, _paperclipWakeContext: { issueId: f.issueId },
        executionWait: { holdingRunId: f.sourceRunId, reason: "execution_reconciliation_required" } },
    });
    expect(wakes[0]!.finishedAt).toBeNull();
    expect(wakes[0]!.payload?.executionWait).toHaveProperty("recoveryActionId");
    // A summary label does not certify the outcome of every effectful action.
    // Keep both the immutable source and the hold until stronger proof exists.
    const [source] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.sourceRunId));
    expect(source!.resultJson?.executionRecovery).toMatchObject({ actionOutcomes: outcome });
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).not.toBeNull();
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId));
    expect(runs).toHaveLength(1);
  });

  it.each(["held", "cleared", "remaining dependency", "owner changed", "operator stop", "unknown cancellation", "second hold"] as const)(
    "redelivers retained dependency closure only through current admission (%s)", async state => {
      const f = await seed();
      await db.delete(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.sourceRunId));
      await db.update(agents).set({ adapterType: "codex_local" }).where(eq(agents.id, f.agentId));
      await db.update(heartbeatRuns).set({ runtimeMode: "legacy", status: "cancelled", resultJson: {
        ...(state === "unknown cancellation" ? {} : { cancellation: {
          source: state === "operator stop" ? "operator" : "shutdown", expected: true,
          initiator: { type: state === "operator stop" ? "user" : "system" },
          reason: "Synthetic stop", recordedAt: new Date().toISOString(),
        } }),
      } }).where(eq(heartbeatRuns.id, f.sourceRunId));
      // Occupy the dispatch slot, keeping the test entirely synthetic.
      const occupied = randomUUID();
      await db.insert(heartbeatRuns).values({ id: occupied, companyId: f.companyId,
        agentId: f.agentId, status: "running", startedAt: new Date(), contextSnapshot: {} });
      const heartbeat = heartbeatService(db);
      try {
        expect(await heartbeat.wakeup(f.agentId, {
          source: "automation", triggerDetail: "system", reason: "issue_blockers_resolved",
          requestedByActorType: "system", requestedByActorId: "issue-dependencies",
          payload: { issueId: f.issueId }, contextSnapshot: { issueId: f.issueId },
        })).toBeNull();
        const [receipt] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId));
        expect(receipt!.status).toBe("deferred_issue_execution");
        if (state !== "held") await db.update(issueRecoveryActions).set({
          evidence: { runId: f.sourceRunId, executionReconciliation: { actionOutcome: "completed" } },
        }).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
        if (state === "second hold") await db.insert(issueRecoveryActions).values({
          companyId: f.companyId, sourceIssueId: f.issueId, kind: "active_run_watchdog",
          cause: "uncertain_external_action", fingerprint: randomUUID(), status: "active",
          evidence: { runId: f.sourceRunId }, nextAction: "Another hold remains unsafe.",
        });
        if (state === "remaining dependency") {
          const blockerId = randomUUID();
          await db.insert(issues).values({ id: blockerId, companyId: f.companyId, title: "Still required", status: "todo" });
          await db.insert(issueRelations).values({ companyId: f.companyId, issueId: blockerId,
            relatedIssueId: f.issueId, type: "blocks" });
        }
        if (state === "owner changed") await db.update(issues).set({ assigneeAgentId: null }).where(eq(issues.id, f.issueId));
        const ageReceipt = () => db.update(agentWakeupRequests).set({ updatedAt: new Date(0) })
          .where(eq(agentWakeupRequests.id, receipt!.id));
        await ageReceipt();
        await heartbeat.resumeQueuedRuns();
        const [retained] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receipt!.id));
        const successors = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId)))
          .filter(run => run.id !== f.sourceRunId && run.id !== occupied);
        if (state === "cleared") {
          expect(successors).toHaveLength(1);
          expect(successors[0]).toMatchObject({ status: "queued", retryOfRunId: null,
            contextSnapshot: { previousRunId: f.sourceRunId, forceFreshSession: true } });
          expect(retained).toMatchObject({ status: "coalesced", runId: successors[0]!.id });
          expect(successors[0]!.contextSnapshot).not.toHaveProperty("explicitUserContinuation");
          await ageReceipt();
          await heartbeat.resumeQueuedRuns();
          expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(3);
        } else {
          expect(successors).toHaveLength(0);
          expect(retained).toMatchObject({ status: "deferred_issue_execution", runId: null });
        }
      } finally {
        await db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.agentId));
        await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() })
          .where(eq(heartbeatRuns.companyId, f.companyId));
        await db.update(agentWakeupRequests).set({ status: "cancelled", finishedAt: new Date() })
          .where(eq(agentWakeupRequests.companyId, f.companyId));
      }
    });

  it.each(["handoff", "foreign_task", "running_source", "different_owner", "mention", "interaction", "chat"])("adopts former-owner comments only during an authorized handoff (%s)", async kind => {
    const f = await seed(), nextAgentId = randomUUID(), queueId = randomUUID();
    await db.delete(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    await db.delete(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.sourceRunId));
    await db.insert(agents).values({ id: nextAgentId, companyId: f.companyId, name: "Replacement", role: "engineer", adapterType: "paperclip_runner", runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } });
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: nextAgentId, status: "running" });
    await db.update(issues).set({ status: "in_progress", assigneeAgentId: kind === "different_owner" ? f.agentId : nextAgentId }).where(eq(issues.id, f.issueId));
    await db.update(heartbeatRuns).set({ status: kind === "running_source" ? "running" : "cancelled", errorCode: "issue_reassigned",
      nativeIssueId: kind === "foreign_task" ? null : f.issueId,
      contextSnapshot: { issueId: kind === "foreign_task" ? randomUUID() : f.issueId } }).where(eq(heartbeatRuns.id, f.sourceRunId));
    const secondId = randomUUID();
    await db.insert(issueComments).values({ id: secondId, companyId: f.companyId, issueId: f.issueId, authorType: "user", authorUserId: "second-user", body: "Preserve the existing draft." });
    await db.insert(agentWakeupRequests).values({ id: queueId, companyId: f.companyId, agentId: f.agentId,
      source: "automation", reason: "issue_execution_deferred", status: "deferred_issue_execution",
      requestedByActorType: "user", requestedByActorId: "board", idempotencyKey: kind === "chat" ? "chat-inbound:handoff-test" : null,
      payload: { issueId: f.issueId, commentId: secondId, _paperclipWakeContext: { issueId: f.issueId,
        wakeReason: kind === "mention" ? "issue_comment_mentioned" : "issue_commented", wakeCommentIds: [f.commentId, secondId],
        ...(kind === "interaction" ? { interactionId: randomUUID(), wakeReason: "connection_intent.resolved" } : {}),
      } },
    });
    await heartbeatService(db).wakeup(nextAgentId, { source: "assignment", triggerDetail: "system", reason: "issue_assigned",
      requestedByActorType: "user", requestedByActorId: "board", payload: { issueId: f.issueId, interruptedRunId: f.sourceRunId },
      contextSnapshot: { issueId: f.issueId, interruptedRunId: f.sourceRunId } });
    const [receipt] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, queueId));
    if (kind === "handoff") {
      expect(receipt.status).toBe("coalesced");
      const [successor] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, receipt.runId!));
      expect(successor).toMatchObject({ agentId: nextAgentId, status: "queued", contextSnapshot: { wakeCommentIds: [f.commentId, secondId] } });
      expect(receipt.requestedByActorId).toBe("board");
      const [comment] = await db.select().from(issueComments).where(eq(issueComments.id, secondId));
      expect(comment.authorUserId).toBe("second-user");
    } else expect(receipt.status).toBe("deferred_issue_execution");
  });
  it.each(["ready", "unacknowledged", "pause", "recovery", "controller", "process_running", "identity_missing", "remote_pending", "remote_stopped", "first_delivered", "last_delivered", "mixed_authors"])("delivers a saved native message after run-only Stop exactly once (%s)", async gate => {
    const f = await seed();
    if (gate !== "recovery") await db.delete(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, f.issueId));
    await db.update(nativeRunFinalizations).set({ phase: "terminal_failure", failureDetail: null, leaseOwner: gate === "controller" ? "still-cleaning" : null })
      .where(eq(nativeRunFinalizations.runId, f.sourceRunId));
    await db.update(issueComments).set({ createdAt: new Date("2026-09-11T09:00:00Z") })
      .where(eq(issueComments.id, f.commentId));
    const [source] = await db.update(heartbeatRuns).set({ status: "cancelled",
      processPid: gate === "process_running" ? process.pid : gate === "identity_missing" ? null : 999999999, resultJson: {
      cancelledByActorType: "user", cancelledByUserId: "board", nativeCancellation: {
        schema: "paperclip.native-cancellation.v1", runId: f.sourceRunId, companyId: f.companyId,
        issueId: f.issueId, scope: "run", reasonCode: "cancellation_run_only", dispatched: true,
        dispatchState: gate === "unacknowledged" ? "requested" : "acknowledged",
        intentAuditId: randomUUID(), acknowledgementAuditId: randomUUID(),
      },
    } }).where(eq(heartbeatRuns.id, f.sourceRunId)).returning();
    // Occupy the agent slot: admission is real, but no provider should launch.
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" });
    if (gate === "pause") {
      const holdId = randomUUID();
      await db.insert(issueTreeHolds).values({ id: holdId, companyId: f.companyId, rootIssueId: f.issueId, mode: "pause", status: "active" });
      await db.insert(issueTreeHoldMembers).values({ companyId: f.companyId, holdId, issueId: f.issueId, depth: 0, issueTitle: "Deploy", issueStatus: "in_progress" });
    }
    let queuedIds = [f.commentId];
    let expectedIds = queuedIds;
    if (["first_delivered", "last_delivered", "mixed_authors"].includes(gate)) {
      const secondId = randomUUID();
      await db.insert(issueComments).values({ id: secondId, companyId: f.companyId, issueId: f.issueId,
        authorType: "user", authorUserId: gate === "mixed_authors" ? "second-author" : "board",
        body: "Keep the earlier direction too.", createdAt: new Date("2026-09-11T09:01:00Z") });
      queuedIds = [f.commentId, secondId];
      expectedIds = gate === "first_delivered" ? [secondId] : gate === "last_delivered" ? [f.commentId] : queuedIds;
      if (gate !== "mixed_authors") await db.update(heartbeatRuns).set({ startedAt: new Date("2026-09-11T09:02:00Z"),
        contextSnapshot: { issueId: f.issueId, wakeCommentIds: gate === "first_delivered" ? [f.commentId] : [secondId] },
      }).where(eq(heartbeatRuns.id, f.sourceRunId));
    }
    const queueId = randomUUID();
    await db.insert(agentWakeupRequests).values({ id: queueId, companyId: f.companyId, agentId: f.agentId,
      source: "automation", triggerDetail: "system", reason: "issue_execution_deferred", status: "deferred_issue_execution",
      requestedByActorType: "user", requestedByActorId: "board", payload: {
        issueId: f.issueId, commentId: queuedIds.at(-1), _paperclipWakeContext: { issueId: f.issueId, wakeReason: "issue_commented", wakeCommentId: queuedIds.at(-1), wakeCommentIds: queuedIds },
      },
    });
    if (gate.startsWith("remote_")) {
      const identity = { id: randomUUID(), companyId: f.companyId, heartbeatRunId: f.sourceRunId,
        provider: "daytona", providerLeaseId: "owned-sandbox" };
      await db.insert(environmentLeases).values({ ...identity, status: gate === "remote_stopped" ? "released" : "active",
        leasePolicy: "ephemeral", releasedAt: gate === "remote_stopped" ? new Date() : null,
        cleanupStatus: gate === "remote_stopped" ? "success" : null,
        metadata: gate === "remote_stopped" ? { remoteExecutionTermination: remoteTerminationReceipt(identity,
          { providerLeaseId: identity.providerLeaseId, state: "stopped" }) } : {},
      });
    }
    const heartbeat = heartbeatService(db);
    await heartbeat.resumeRemoteStopComments(source);
    await heartbeat.resumeRemoteStopComments(source);
    const successors = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.status, "queued")));
    expect(successors).toHaveLength(["ready", "remote_stopped", "first_delivered", "last_delivered", "mixed_authors"].includes(gate) ? 1 : 0);
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, queueId));
    if (["ready", "remote_stopped", "first_delivered", "last_delivered", "mixed_authors"].includes(gate)) {
      expect(wake).toMatchObject({ status: "coalesced", runId: successors[0].id, requestedByActorId: "board" });
      expect(successors[0].contextSnapshot).toMatchObject({ wakeCommentIds: expectedIds });
      expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
    } else expect(wake.status).toBe("deferred_issue_execution");
  });
  it.each(["pending", "failed", "historical", "shared", "retained"])("an explicit queued interrupt retries only its stopped sandbox, without granting automatic retries (%s)", async scenario => {
    const fails = scenario === "failed";
    const protectedLease = scenario === "shared" || scenario === "retained";
    const f = await seed(), other = await seed();
    await db.update(agents).set({ adapterType: "claude_local" }).where(eq(agents.id, f.agentId));
    await db.delete(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.sourceRunId));
    await db.update(heartbeatRuns).set({ runtimeMode: "legacy", nativeIssueId: null, processPid: null })
      .where(eq(heartbeatRuns.id, f.sourceRunId));
    await db.update(issueRecoveryActions).set({ cause: "legacy_execution_requires_reconciliation" })
      .where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" });
    const queueId = randomUUID();
    await db.insert(agentWakeupRequests).values({ id: queueId, companyId: f.companyId, agentId: f.agentId,
      source: "automation", reason: "issue_commented", status: "deferred_issue_execution",
      requestedByActorType: "system", payload: { issueId: f.issueId, commentId: f.commentId,
        _paperclipWakeContext: { wakeCommentIds: [f.commentId] },
        queuedCommentInterrupt: { actorId: "board", requestedAt: new Date().toISOString() } },
    });
    const identities = [f, other].map(fixture => ({ id: randomUUID(), companyId: fixture.companyId,
      heartbeatRunId: fixture.sourceRunId, provider: "daytona", providerLeaseId: fixture.sourceRunId }));
    for (const identity of identities) await db.insert(environmentLeases).values({ ...identity,
      status: "pending_cleanup", leasePolicy: "ephemeral", releasedAt: new Date(), cleanupStatus: "failed",
      metadata: { pendingCleanupRetryAttempts: 5, pendingCleanupRetryCapWarned: true } });
    if (scenario === "historical" || protectedLease) await db.update(environmentLeases).set({
      status: "failed", cleanupStatus: "success",
    }).where(eq(environmentLeases.id, identities[0].id));
    if (scenario === "shared") await db.update(environmentLeases).set({
      providerLeaseId: identities[0].providerLeaseId, status: "active", releasedAt: null,
    }).where(eq(environmentLeases.id, identities[1].id));
    if (scenario === "retained") await db.update(environmentLeases).set({
      status: "retained", leasePolicy: "retain_on_failure",
    }).where(eq(environmentLeases.id, identities[0].id));
    const attempted: string[] = [];
    const heartbeat = heartbeatService(db, { environmentRuntime: {
      isPendingCleanupWorkerReady: async () => true,
      retryPendingSandboxTeardown: async ({ lease }: { lease: { id: string; providerLeaseId: string } }) => {
        attempted.push(lease.id);
        if (fails) throw new Error("Provider unavailable");
        return { providerLeaseId: lease.providerLeaseId, state: "destroyed" };
      },
    } as unknown as HeartbeatEnvironmentRuntime });
    try {
      await heartbeat.resumeQueuedCommentInterrupt(f.companyId, queueId);
      expect(attempted).toEqual([]);
      await heartbeat.resumeQueuedCommentInterrupt(f.companyId, queueId, { retryCleanup: true });
      expect(attempted).toEqual(protectedLease ? [] : [identities[0].id]);
      await heartbeat.resumeQueuedCommentInterrupt(f.companyId, queueId);
      expect(attempted).toHaveLength(protectedLease ? 0 : 1);
      const [queue] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, queueId));
      expect(queue.status).toBe(fails || protectedLease ? "deferred_issue_execution" : "coalesced");
      expect(Boolean(queue.runId)).toBe(!fails && !protectedLease);
      const [untouched] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, identities[1].id));
      expect(untouched).toMatchObject({ status: scenario === "shared" ? "active" : "pending_cleanup", metadata: { pendingCleanupRetryAttempts: 5 } });
    } finally {
      for (const identity of identities) await db.delete(environmentLeases).where(eq(environmentLeases.id, identity.id));
    }
  });
  it("a durable queue interrupt authorizes older legacy messages but still requires the provider to stop", async () => {
    const f = await seed();
    await db.update(agents).set({ adapterType: "claude_local" }).where(eq(agents.id, f.agentId));
    await db.delete(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.sourceRunId));
    await db.update(heartbeatRuns).set({ runtimeMode: "legacy", nativeIssueId: null,
      processPid: process.pid,
    }).where(eq(heartbeatRuns.id, f.sourceRunId));
    await db.update(issueRecoveryActions).set({ cause: "legacy_execution_requires_reconciliation" })
      .where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    await db.update(issueComments).set({ authorUserId: "original-author", createdAt: new Date("2026-09-11T09:00:00Z") })
      .where(eq(issueComments.id, f.commentId));
    const queueId = randomUUID();
    await db.insert(agentWakeupRequests).values({ id: queueId, companyId: f.companyId, agentId: f.agentId,
      source: "on_demand", reason: "issue_commented", status: "deferred_issue_execution",
      requestedByActorType: "user", requestedByActorId: "original-author",
      payload: { issueId: f.issueId, _paperclipWakeContext: { wakeCommentIds: [f.commentId] },
        queuedCommentInterrupt: { actorId: "board", requestedAt: new Date().toISOString() } },
    });
    const attempt = (queue = queueId) => db.transaction(async tx => {
      await tx.select().from(issues).where(eq(issues.id, f.issueId)).for("update");
      return admitExplicitNativeContinuation({ ...f, db: tx as unknown as typeof db,
        queuedCommentInterruptId: queue, dryRun: true });
    });
    expect(await attempt()).toBeNull();
    await db.update(heartbeatRuns).set({ processPid: 999999999 }).where(eq(heartbeatRuns.id, f.sourceRunId));
    expect(await attempt(randomUUID())).toBeNull();
    expect(await attempt()).toMatchObject({ previousRunId: f.sourceRunId, commentId: f.commentId });
    await db.update(agentWakeupRequests).set({ status: "cancelled" }).where(eq(agentWakeupRequests.id, queueId));
    expect(await attempt()).toBeNull();
  });
  it("dispatches another user's queued legacy message using the consumed board interrupt receipt", async () => {
    const f = await seed();
    await db.update(agents).set({ adapterType: "claude_local" }).where(eq(agents.id, f.agentId));
    await db.delete(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.sourceRunId));
    await db.update(heartbeatRuns).set({ runtimeMode: "legacy", nativeIssueId: null })
      .where(eq(heartbeatRuns.id, f.sourceRunId));
    await db.update(issueRecoveryActions).set({ cause: "legacy_execution_requires_reconciliation" })
      .where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    await db.update(issueComments).set({ authorUserId: "original-author", createdAt: new Date("2026-09-11T09:00:00Z") })
      .where(eq(issueComments.id, f.commentId));
    // Hold adapter startup so the test can exercise the real dispatch envelope
    // deterministically, without invoking a provider.
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" });
    const queueId = randomUUID();
    await db.insert(agentWakeupRequests).values({ id: queueId, companyId: f.companyId, agentId: f.agentId,
      source: "automation", reason: "issue_commented", status: "deferred_issue_execution",
      requestedByActorType: "system", payload: { issueId: f.issueId, commentId: f.commentId,
        _paperclipWakeContext: { wakeCommentIds: [f.commentId] },
        queuedCommentInterrupt: { actorId: "board", requestedAt: new Date().toISOString() } },
    });
    await heartbeatService(db).resumeQueuedCommentInterrupt(f.companyId, queueId);
    const [receipt] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, queueId));
    expect(receipt.status).toBe("coalesced");
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, receipt.runId!));
    const dispatch = (runId = run.id) => buildExecutionContinuation({ db, companyId: f.companyId,
      issueId: f.issueId, agentId: f.agentId, runId, context: run.contextSnapshot!,
      summary: null, exposeLowTrustRaw: false });
    const envelope = await dispatch();
    expect(envelope.interruptedRunId).toBe(f.sourceRunId);
    expect(envelope.originCommentIds).toContain(f.commentId);
    expect(envelope.messages).toEqual(expect.arrayContaining([expect.objectContaining({ id: f.commentId, body: "What happened?" })]));
    await expect(dispatch(randomUUID())).rejects.toThrow("continuation_user_authorization_missing");
    for (const patch of [
      { status: "cancelled" }, { runId: f.sourceRunId },
      { payload: { ...receipt.payload, issueId: randomUUID() } },
      { payload: { ...receipt.payload, queuedCommentInterrupt: { actorId: "someone-else" } } },
      { payload: { ...receipt.payload, _paperclipWakeContext: { wakeCommentIds: [] }, commentId: undefined } },
    ]) {
      await db.update(agentWakeupRequests).set(patch).where(eq(agentWakeupRequests.id, queueId));
      await expect(dispatch()).rejects.toThrow("continuation_user_authorization_missing");
      await db.update(agentWakeupRequests).set({ status: receipt.status, runId: receipt.runId, payload: receipt.payload })
        .where(eq(agentWakeupRequests.id, queueId));
    }
    const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    await db.update(issueRecoveryActions).set({ evidence: { ...action.evidence,
      explicitUserContinuation: { ...(action.evidence.explicitUserContinuation as Record<string, unknown>),
        queuedCommentInterruptId: "malformed-historical-receipt" },
    } }).where(eq(issueRecoveryActions.id, action.id));
    await expect(dispatch()).rejects.toThrow("continuation_user_authorization_missing");
  });
  it.each(["valid", "stale_retry_context", "wrong_actor", "wrong_run", "wrong_company", "discarded"])("verifies another author's queued Interrupt at execution setup: %s", async kind => {
    const f = await seed();
    await db.update(agents).set({ adapterType: "claude_local" }).where(eq(agents.id, f.agentId));
    await db.delete(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.sourceRunId));
    await db.update(heartbeatRuns).set({ runtimeMode: "legacy", nativeIssueId: null })
      .where(eq(heartbeatRuns.id, f.sourceRunId));
    await db.update(issueRecoveryActions).set({ cause: "legacy_execution_requires_reconciliation" })
      .where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    await db.update(issueComments).set({ authorUserId: "original-author", createdAt: new Date("2026-09-11T09:00:00Z") })
      .where(eq(issueComments.id, f.commentId));
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
      status: "running", contextSnapshot: { issueId: randomUUID() } });
    const queueId = randomUUID();
    const payload = { issueId: f.issueId, _paperclipWakeContext: { wakeCommentIds: [f.commentId] },
      queuedCommentInterrupt: { actorId: "board", requestedAt: new Date().toISOString() } };
    await db.insert(agentWakeupRequests).values({ id: queueId, companyId: f.companyId, agentId: f.agentId,
      source: "automation", reason: "issue_commented", status: "deferred_issue_execution",
      requestedByActorType: "system", payload });
    await heartbeatService(db).resumeQueuedCommentInterrupt(f.companyId, queueId);
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, queueId));
    expect(wake.status).toBe("coalesced");
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, wake.runId!));
    if (kind === "wrong_actor") await db.update(agentWakeupRequests).set({
      payload: { ...payload, queuedCommentInterrupt: { ...payload.queuedCommentInterrupt, actorId: "forged" } },
    }).where(eq(agentWakeupRequests.id, queueId));
    if (kind === "wrong_run") await db.update(agentWakeupRequests).set({ runId: f.sourceRunId })
      .where(eq(agentWakeupRequests.id, queueId));
    if (kind === "wrong_company") await db.update(agentWakeupRequests).set({ companyId: (await seed()).companyId })
      .where(eq(agentWakeupRequests.id, queueId));
    if (kind === "discarded") await db.update(issueComments).set({ deletedAt: new Date() })
      .where(eq(issueComments.id, f.commentId));
    const result = buildExecutionContinuation({ db, companyId: f.companyId, issueId: f.issueId,
      agentId: f.agentId, runId: run.id, context: {
        ...run.contextSnapshot, ...(kind === "stale_retry_context" ? { retryOfRunId: randomUUID() } : {}),
      }, summary: null, exposeLowTrustRaw: false });
    if (kind === "valid" || kind === "stale_retry_context") await expect(result).resolves.toMatchObject({ interruptedRunId: f.sourceRunId });
    else await expect(result).rejects.toThrow("continuation_user_authorization_missing");
  });

  it.each(["valid", "provider_cancel", "pending_tool", "unknown_cancel", "wrong_actor", "consumed", "discarded", "operator_stop", "already_delivered", "earlier_delivered", "unstarted_cancelled", "unstarted_cancelled_metadata", "foreign_queue"])("validates automatic saved-message delivery: %s", async kind => {
    const f = await seed();
    await db.update(agents).set({ adapterType: "claude_local" }).where(eq(agents.id, f.agentId));
    await db.delete(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.sourceRunId));
    await db.update(heartbeatRuns).set({ runtimeMode: "legacy", nativeIssueId: null,
      status: ["operator_stop", "provider_cancel", "pending_tool", "unknown_cancel"].includes(kind) ? "cancelled" : "failed",
      startedAt: new Date("2026-09-11T08:00:00Z"),
      ...(["provider_cancel", "pending_tool"].includes(kind) ? { resultJson: {
        acpToolInventoryComplete: true, acpPendingToolCount: kind === "pending_tool" ? 1 : 0,
        cancellation: { source: "provider", expected: false, initiator: { type: "provider" },
          reason: "Provider cancelled execution", recordedAt: new Date().toISOString() },
      } } : {}),
      contextSnapshot: { issueId: f.issueId, ...(kind === "already_delivered" ? { wakeCommentIds: [f.commentId] } : {}) },
    }).where(eq(heartbeatRuns.id, f.sourceRunId));
    await db.update(issueRecoveryActions).set({ cause: "legacy_execution_requires_reconciliation" })
      .where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    await db.update(issueComments).set({ createdAt: new Date("2026-09-11T09:00:00Z"),
      ...(kind === "discarded" ? { deletedAt: new Date() } : {}),
    }).where(eq(issueComments.id, f.commentId));
    const queueId = randomUUID();
    await db.insert(agentWakeupRequests).values({ id: queueId, companyId: f.companyId, agentId: f.agentId,
      source: "automation", reason: "issue_commented", status: kind === "consumed" ? "coalesced" : "deferred_issue_execution",
      requestedByActorType: "system", payload: { issueId: kind === "foreign_queue" ? randomUUID() : f.issueId,
        _paperclipWakeContext: { wakeCommentIds: [f.commentId] } },
    });
    if (kind.startsWith("unstarted_cancelled")) {
      await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
        status: "cancelled", runtimeMode: "legacy", errorCode: "agent_paused", finishedAt: new Date(),
        ...(kind === "unstarted_cancelled_metadata" ? { nativeIssueId: f.issueId, processPid: 999999999, processGroupId: 999999999 } : {}),
        contextSnapshot: { issueId: f.issueId, wakeCommentIds: [f.commentId] },
      });
    }
    if (kind === "earlier_delivered") {
      const earlierId = randomUUID();
      await db.insert(issueComments).values({ id: earlierId, companyId: f.companyId, issueId: f.issueId,
        authorType: "user", authorUserId: f.actorId, body: "Already handled" });
      await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.issueId, wakeCommentIds: [earlierId] } })
        .where(eq(heartbeatRuns.id, f.sourceRunId));
      await db.update(agentWakeupRequests).set({ payload: { issueId: f.issueId,
        _paperclipWakeContext: { wakeCommentIds: [earlierId, f.commentId] } } })
        .where(eq(agentWakeupRequests.id, queueId));
    }
    const result = await db.transaction(async tx => {
      await tx.select().from(issues).where(eq(issues.id, f.issueId)).for("update");
      return admitExplicitNativeContinuation({ ...f, actorId: kind === "wrong_actor" ? "someone-else" : f.actorId,
        db: tx as unknown as typeof db, queuedCommentRequestId: queueId, dryRun: true });
    });
    if (kind === "valid" || kind === "provider_cancel" || kind.startsWith("unstarted_cancelled")) expect(result).toMatchObject({ previousRunId: f.sourceRunId, commentId: f.commentId });
    else expect(result).toBeNull();
  });

  const admit = (f: Fixture, dryRun = false) => db.transaction(async tx => {
    await tx.select().from(issues).where(eq(issues.id, f.issueId)).for("update");
    const result = await admitExplicitNativeContinuation({ ...f, dryRun, db: tx as unknown as typeof db });
    if (result && !dryRun) await tx.insert(heartbeatRuns).values({ id: f.successorRunId, companyId: f.companyId,
      agentId: f.agentId, status: "queued", contextSnapshot: { issueId: f.issueId, previousRunId: result.previousRunId, forceFreshSession: true } });
    return result;
  });

  it.each(["other_user", "same_user", "unaddressed", "tool_access"])("scopes connection waits to the user starting the fresh turn (%s)", async audience => {
    const f = await seed();
    await db.update(heartbeatRuns).set({ status: "cancelled", errorCode: "slack_session_stopped" })
      .where(eq(heartbeatRuns.id, f.sourceRunId));
    const [interaction] = await db.insert(issueThreadInteractions).values({
      companyId: f.companyId, issueId: f.issueId, sourceRunId: f.sourceRunId,
      createdByAgentId: f.agentId, kind: "connection_intent", status: "pending",
      addresseeUserId: ["other_user", "tool_access"].includes(audience) ? "other-user" : audience === "same_user" ? "board" : null,
      effectiveResolverPolicy: "human_only",
      payload: { version: 1, ...(audience === "tool_access" ? {} : { purpose: "ai" as const }), serviceSlug: "openai", serviceName: "OpenAI",
        requestingAgentId: f.agentId, requestingAgentName: "Native", phase: "requested" },
    }).returning();
    expect(await admit(f)).toEqual(audience === "other_user"
      ? { previousRunId: f.sourceRunId, commentId: f.commentId } : null);
    // Starting another user's turn grants no connection authority and retains the card.
    expect((await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, interaction.id)))[0])
      .toMatchObject({ status: "pending", result: null, addresseeUserId: interaction.addresseeUserId });
    const blocker = await getExecutionBlocker(db, f.companyId, f.issueId);
    if (audience === "other_user") expect(blocker).toBeNull();
    else expect(blocker).not.toBeNull();
  });

  it.each(["fresh", "before_stop", "delivered", "unknown_stop_time", "wrong_actor", "approval"])(
    "resumes an already-saved follow-up after native Slack Stop (%s)", async gate => {
      const f = await seed(), queueId = randomUUID();
      await db.update(heartbeatRuns).set({ status: "cancelled", errorCode: "slack_session_stopped",
        startedAt: new Date("2026-09-11T09:30:00Z"), finishedAt: gate === "unknown_stop_time" ? null : new Date("2026-09-11T10:00:00Z"),
        contextSnapshot: { issueId: f.issueId, ...(gate === "delivered" ? { wakeCommentId: f.commentId } : {}) },
        // Pre-fix Slack Stops recorded a system cancellation, with no operator identity.
        resultJson: { cancellation: { source: "control_plane", expected: true, initiator: { type: "system" },
          reason: "Stopped from the bound Slack agent session", recordedAt: "2026-09-11T10:00:00Z" } },
      }).where(eq(heartbeatRuns.id, f.sourceRunId));
      if (gate === "before_stop") await db.update(issueComments).set({ createdAt: new Date("2026-09-11T09:00:00Z") })
        .where(eq(issueComments.id, f.commentId));
      await db.insert(issueThreadInteractions).values({
        companyId: f.companyId, issueId: f.issueId, sourceRunId: f.sourceRunId,
        createdByAgentId: f.agentId, kind: "connection_intent", status: "pending", addresseeUserId: "other-user",
        effectiveResolverPolicy: "human_only", payload: { version: 1, purpose: "ai", serviceSlug: "openai",
          serviceName: "OpenAI", requestingAgentId: f.agentId, requestingAgentName: "Native", phase: "requested" },
      });
      if (gate === "approval") {
        const [approval] = await db.insert(approvals).values({ companyId: f.companyId, type: "hire_agent", status: "pending", payload: {} }).returning();
        await db.insert(issueApprovals).values({ companyId: f.companyId, issueId: f.issueId, approvalId: approval.id });
      }
      await db.insert(agentWakeupRequests).values({ id: queueId, companyId: f.companyId, agentId: f.agentId,
        source: "automation", reason: "issue_execution_deferred", status: "deferred_issue_execution",
        requestedByActorType: "user", requestedByActorId: gate === "wrong_actor" ? "other-user" : "board",
        payload: { issueId: f.issueId, commentId: f.commentId, _paperclipWakeContext: {
          issueId: f.issueId, wakeReason: "issue_commented", wakeCommentId: f.commentId, wakeCommentIds: [f.commentId] } },
      });
      const result = await db.transaction(async tx => {
        await tx.select().from(issues).where(eq(issues.id, f.issueId)).for("update");
        return admitExplicitNativeContinuation({ ...f, actorId: gate === "wrong_actor" ? "other-user" : f.actorId,
          db: tx as unknown as typeof db, queuedCommentRequestId: queueId, dryRun: true });
      });
      expect(result).toEqual(gate === "fresh" ? { previousRunId: f.sourceRunId, commentId: f.commentId } : null);
    },
  );

  async function seedTimedOutExplicitTurn() {
    const f = await seed();
    const explicitUserContinuation = await admit(f);
    expect(explicitUserContinuation).not.toBeNull();
    const [receipt] = await db.select().from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    await db.update(agents).set({ adapterType: "claude_local" }).where(eq(agents.id, f.agentId));
    const now = new Date();
    const [parent] = await db.update(heartbeatRuns).set({ runtimeMode: "legacy", status: "timed_out",
      errorCode: "timeout", startedAt: now, finishedAt: now,
      resultJson: { conversationContinuation: CONVERSATION_CONTINUATION_POLICY },
      contextSnapshot: { issueId: f.issueId, wakeReason: "issue_commented", wakeCommentId: f.commentId,
        previousRunId: f.sourceRunId, explicitUserContinuation },
    }).where(eq(heartbeatRuns.id, f.successorRunId)).returning();
    await db.update(issues).set({ status: "in_progress", executionRunId: parent.id })
      .where(eq(issues.id, f.issueId));
    return { ...f, parent, receipt, now };
  }
  const dispatchExplicitRetry = (f: Fixture, run: typeof heartbeatRuns.$inferSelect) => buildExecutionContinuation({
    db, companyId: f.companyId, issueId: f.issueId, agentId: f.agentId, runId: run.id,
    context: run.contextSnapshot!, summary: null, exposeLowTrustRaw: false,
  });

  it("re-admits an explicit user turn's timeout retry with its own durable authorization", async () => {
    const f = await seedTimedOutExplicitTurn();
    await expect(dispatchExplicitRetry(f, f.parent)).resolves.toMatchObject({ interruptedRunId: f.sourceRunId });
    const heartbeat = heartbeatService(db);
    const [scheduled, competing] = await Promise.all([
      heartbeat.scheduleBoundedRetry(f.parent.id, { now: f.now, delayMs: 1000 }),
      heartbeat.scheduleBoundedRetry(f.parent.id, { now: f.now, delayMs: 1000 }),
    ]);
    expect(scheduled.outcome).toBe("scheduled");
    if (scheduled.outcome !== "scheduled") return;
    expect(competing).toMatchObject({ outcome: "scheduled", run: { id: scheduled.run.id } });
    expect(scheduled.run.contextSnapshot?.explicitUserContinuation).toEqual({
      previousRunId: f.parent.id, commentId: f.commentId,
    });
    // Dispatch validates the new run, not a borrowed parent receipt.
    await expect(dispatchExplicitRetry(f, scheduled.run)).resolves.toMatchObject({ interruptedRunId: f.parent.id });
    const receipts = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    expect(receipts).toHaveLength(2);
    expect(receipts.find(row => row.id === f.receipt.id)?.evidence).toEqual(f.receipt.evidence);
    expect(receipts.find(row => row.id !== f.receipt.id)?.evidence.explicitUserContinuation).toMatchObject({
      runId: scheduled.run.id, previousRunId: f.parent.id, actorId: "board", commentId: f.commentId,
      automaticRetry: { sourceRunId: f.parent.id, sourceAuthorizationId: f.receipt.id },
    });
    expect(await heartbeat.scheduleBoundedRetry(f.parent.id, { now: f.now })).toMatchObject({
      outcome: "scheduled", run: { id: scheduled.run.id },
    });
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId))).toHaveLength(2);
    // Removing the new receipt reproduces the original dispatch failure.
    await db.delete(issueRecoveryActions).where(eq(issueRecoveryActions.id, receipts.find(row => row.id !== f.receipt.id)!.id));
    await expect(dispatchExplicitRetry(f, scheduled.run)).rejects.toThrow("continuation_user_authorization_missing");
  });

  it("waits for the parent adapter controller even when no environment lease remains", async () => {
    const f = await seedTimedOutExplicitTurn();
    const heartbeat = heartbeatService(db);
    const control = createAdapterExecutionControl();
    adapterExecutionControls.set(f.parent.id, control);
    try {
      expect(await heartbeat.scheduleBoundedRetry(f.parent.id)).toMatchObject({ outcome: "not_scheduled" });
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, f.parent.id))).toHaveLength(0);
      expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId))).toHaveLength(1);
    } finally {
      adapterExecutionControls.delete(f.parent.id);
      control.finish();
    }
    expect(await heartbeat.scheduleBoundedRetry(f.parent.id)).toMatchObject({ outcome: "scheduled" });
  });

  it("binds each bounded explicit retry to its immediate parent without replacing prior receipts", async () => {
    const f = await seedTimedOutExplicitTurn();
    const heartbeat = heartbeatService(db);
    const first = await heartbeat.scheduleBoundedRetry(f.parent.id, { now: f.now });
    expect(first.outcome).toBe("scheduled");
    if (first.outcome !== "scheduled") return;
    const nextNow = new Date(f.now.getTime() + 2000);
    await db.update(heartbeatRuns).set({ status: "timed_out", errorCode: "timeout", startedAt: f.now,
      finishedAt: nextNow }).where(eq(heartbeatRuns.id, first.run.id));
    const second = await heartbeat.scheduleBoundedRetry(first.run.id, { now: nextNow });
    expect(second.outcome).toBe("scheduled");
    if (second.outcome !== "scheduled") return;
    expect(second.run).toMatchObject({ retryOfRunId: first.run.id, scheduledRetryAttempt: 2 });
    await expect(dispatchExplicitRetry(f, second.run)).resolves.toMatchObject({ interruptedRunId: first.run.id });
    const receipts = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    expect(receipts).toHaveLength(3);
    expect(receipts.find(row => row.id === f.receipt.id)?.evidence).toEqual(f.receipt.evidence);
    await db.update(heartbeatRuns).set({ status: "timed_out", errorCode: "timeout", startedAt: nextNow,
      finishedAt: nextNow }).where(eq(heartbeatRuns.id, second.run.id));
    expect(await heartbeat.scheduleBoundedRetry(second.run.id, { now: nextNow })).toMatchObject({ outcome: "retry_exhausted" });
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId))).toHaveLength(3);
  });

  it("keeps sub-millisecond source ordering when authorizing a timeout retry", async () => {
    const f = await seedTimedOutExplicitTurn();
    await db.execute(sql`update heartbeat_runs set created_at = ${f.now.toISOString()}::timestamptz +
      case when id = ${f.sourceRunId} then interval '100 microseconds' else interval '500 microseconds' end
      where company_id = ${f.companyId} and id in (${f.sourceRunId}, ${f.parent.id})`);
    const result = await heartbeatService(db).scheduleBoundedRetry(f.parent.id, { now: f.now });
    expect(result.outcome).toBe("scheduled");
  });

  it.each(["max_turns_continuation", "interaction_continuation_infra_retry", "workspace_busy"])(
    "does not lend explicit user authority to the separate %s retry contract", async retryReason => {
      const f = await seedTimedOutExplicitTurn();
      const result = await heartbeatService(db).scheduleBoundedRetry(f.parent.id, { now: f.now, retryReason });
      expect(result.outcome).not.toBe("scheduled");
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, f.parent.id))).toHaveLength(0);
    },
  );

  it.each(["deleted", "edited", "same_millisecond_edit", "empty", "actor", "run_authored", "legacy_receipt", "receipt_run", "receipt_company", "source", "task", "reassigned", "done", "superseded", "native_superseding", "interrupted_intent"])(
    "refuses to re-admit an automatic explicit retry after %s changes", async kind => {
      const f = await seedTimedOutExplicitTurn();
      if (["deleted", "edited", "same_millisecond_edit", "empty", "actor", "run_authored"].includes(kind)) await db.update(issueComments).set({
        ...(kind === "deleted" ? { deletedAt: new Date() } : {}),
        ...(kind === "edited" ? { body: "Different instructions", updatedAt: new Date(f.now.getTime() + 1000) } : {}),
        ...(kind === "same_millisecond_edit" ? { body: "Different instructions within the recorded millisecond" } : {}),
        ...(kind === "empty" ? { body: " " } : {}),
        ...(kind === "actor" ? { authorUserId: "another-user" } : {}),
        ...(kind === "run_authored" ? { createdByRunId: f.parent.id } : {}),
      }).where(eq(issueComments.id, f.commentId));
      if (["receipt_run", "interrupted_intent"].includes(kind)) await db.update(issueRecoveryActions).set({ evidence: {
        ...f.receipt.evidence, explicitUserContinuation: {
          ...(f.receipt.evidence.explicitUserContinuation as Record<string, unknown>),
          ...(kind === "receipt_run" ? { runId: randomUUID() } : { queuedCommentInterruptId: randomUUID() }),
        },
      } }).where(eq(issueRecoveryActions.id, f.receipt.id));
      if (kind === "receipt_company") await db.update(issueRecoveryActions).set({ companyId: (await seed()).companyId })
        .where(eq(issueRecoveryActions.id, f.receipt.id));
      if (kind === "legacy_receipt") {
        const { commentBodyHash: _bodyHash, commentUpdatedAt: _updatedAt, ...legacy } =
          f.receipt.evidence.explicitUserContinuation as Record<string, unknown>;
        await db.update(issueRecoveryActions).set({ evidence: { ...f.receipt.evidence,
          explicitUserContinuation: legacy } }).where(eq(issueRecoveryActions.id, f.receipt.id));
      }
      if (kind === "source" || kind === "task") await db.update(heartbeatRuns).set({ contextSnapshot: {
        ...f.parent.contextSnapshot,
        ...(kind === "task" ? { issueId: randomUUID() } : { explicitUserContinuation: { previousRunId: randomUUID(), commentId: f.commentId } }),
      } }).where(eq(heartbeatRuns.id, f.parent.id));
      if (kind === "reassigned" || kind === "done") await db.update(issues).set(kind === "done"
        ? { status: "done" } : { assigneeAgentId: null }).where(eq(issues.id, f.issueId));
      if (kind === "superseded") await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
        status: "succeeded", contextSnapshot: { issueId: f.issueId }, createdAt: new Date(f.now.getTime() + 1000) });
      if (kind === "native_superseding") await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
        status: "running", runtimeMode: "native", nativeIssueId: f.issueId, contextSnapshot: {} });
      const result = await heartbeatService(db).scheduleBoundedRetry(f.parent.id, { now: f.now });
      expect(result.outcome).not.toBe("scheduled");
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, f.parent.id))).toHaveLength(0);
      expect(await db.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.sourceIssueId, f.issueId),
        eq(issueRecoveryActions.cause, "explicit_user_continuation_retry")))).toHaveLength(0);
    },
  );

  it("binds the initial user-message admission before any automatic retry", async () => {
    const f = await seedTimedOutExplicitTurn();
    await expect(dispatchExplicitRetry(f, f.parent)).resolves.toMatchObject({ interruptedRunId: f.sourceRunId });
    await db.update(issueComments).set({ body: "Changed after the original admission" })
      .where(eq(issueComments.id, f.commentId));
    await expect(dispatchExplicitRetry(f, f.parent)).rejects.toThrow("continuation_user_authorization_missing");
  });

  it.each(["deleted", "edited", "same_millisecond_edit", "actor", "receipt_run", "receipt_source", "retry_parent", "execution_owner"])(
    "revalidates the successor's exact authorization at dispatch: %s", async kind => {
      const f = await seedTimedOutExplicitTurn();
      const scheduled = await heartbeatService(db).scheduleBoundedRetry(f.parent.id, { now: f.now });
      expect(scheduled.outcome).toBe("scheduled");
      if (scheduled.outcome !== "scheduled") return;
      if (["deleted", "edited", "same_millisecond_edit", "actor"].includes(kind)) await db.update(issueComments).set({
        ...(kind === "deleted" ? { deletedAt: new Date() } : {}),
        ...(kind === "edited" ? { body: "Changed after scheduling", updatedAt: new Date(f.now.getTime() + 1000) } : {}),
        ...(kind === "same_millisecond_edit" ? { body: "Changed within the recorded millisecond" } : {}),
        ...(kind === "actor" ? { authorUserId: "another-user" } : {}),
      }).where(eq(issueComments.id, f.commentId));
      if (kind === "receipt_run" || kind === "receipt_source") {
        const [receipt] = await db.select().from(issueRecoveryActions).where(and(
          eq(issueRecoveryActions.sourceIssueId, f.issueId), eq(issueRecoveryActions.cause, "explicit_user_continuation_retry")));
        await db.update(issueRecoveryActions).set({ evidence: { ...receipt.evidence, explicitUserContinuation: {
          ...(receipt.evidence.explicitUserContinuation as Record<string, unknown>),
          ...(kind === "receipt_run" ? { runId: f.parent.id } : { previousRunId: f.sourceRunId }),
        } } }).where(eq(issueRecoveryActions.id, receipt.id));
      }
      if (kind === "retry_parent") await db.update(heartbeatRuns).set({ retryOfRunId: f.sourceRunId })
        .where(eq(heartbeatRuns.id, scheduled.run.id));
      if (kind === "execution_owner") await db.update(issues).set({ executionRunId: f.parent.id })
        .where(eq(issues.id, f.issueId));
      await expect(dispatchExplicitRetry(f, scheduled.run)).rejects.toThrow("continuation_user_authorization_missing");
    },
  );

  it.each(["active", "removed", "unavailable", "paused", "disabled"])("shows usable recovery guidance for external chat cancellations: %s", async kind => {
    const f = await seed();
    await db.delete(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.sourceRunId));
    await db.update(heartbeatRuns).set({ runtimeMode: "legacy", status: "cancelled", nativeIssueId: null,
      startedAt: new Date("2026-09-11T08:00:00Z"), resultJson: {
        acpToolInventoryComplete: true, acpPendingToolCount: 0,
        cancellation: { source: "provider", expected: false, initiator: { type: "provider" },
          reason: "Provider cancelled execution", recordedAt: new Date().toISOString() },
      },
    }).where(eq(heartbeatRuns.id, f.sourceRunId));
    await db.update(issueRecoveryActions).set({ cause: "legacy_execution_requires_reconciliation" })
      .where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({ canContinue: true });
    const applicationId = randomUUID(), connectionId = randomUUID(), endpointId = randomUUID();
    await db.insert(toolApplications).values({ id: applicationId, companyId: f.companyId, name: "Slack", type: "chat" });
    await db.insert(toolConnections).values({ id: connectionId, companyId: f.companyId, applicationId,
      name: "Slack", uid: connectionId, transport: "chat_sdk", connectionPurpose: "channel", status: "active", enabled: kind !== "disabled" });
    await db.insert(chatEndpoints).values({ id: endpointId, companyId: f.companyId, connectionId,
      provider: "slack", publicId: endpointId, assignedAgentId: f.agentId,
      status: kind === "removed" ? "archived" : kind === "paused" ? "paused" : "active" });
    await db.insert(chatConversations).values({ companyId: f.companyId, endpointId, issueId: f.issueId,
      externalConversationId: "channel", externalLabel: "#recovery",
      state: kind === "removed" ? "endpoint_removed" : kind === "unavailable" ? "unavailable" : "active" });
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({
      runId: f.sourceRunId, canContinue: false,
      nextAction: kind === "active" ? "Send a new chat message to continue this conversation."
        : kind === "removed" ? "This chat connection was removed. Inspect the stopped run and create a new task to continue the work."
        : "This chat connection is unavailable. Restore access in Apps or create a new task to continue the work.",
    });
  });

  it("delivers saved messages once after provider cancellation, preserving source history", async () => {
    const f = await seed();
    await db.update(agents).set({ adapterType: "claude_local" }).where(eq(agents.id, f.agentId));
    // Hold agent capacity so the test observes durable admission without launching a provider.
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" });
    await db.delete(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.sourceRunId));
    const resultJson = { status: "cancelled", acpToolInventoryComplete: true, acpPendingToolCount: 0,
      cancellation: { source: "provider", expected: false, initiator: { type: "provider" },
        reason: "Provider cancelled execution", recordedAt: new Date().toISOString() },
      completedAction: "preserve-this-record" };
    await db.update(heartbeatRuns).set({ runtimeMode: "legacy", status: "cancelled", nativeIssueId: null,
      startedAt: new Date("2026-09-11T08:00:00Z"), resultJson,
    }).where(eq(heartbeatRuns.id, f.sourceRunId));
    await db.update(issueRecoveryActions).set({ cause: "legacy_execution_requires_reconciliation" })
      .where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    const queueId = randomUUID();
    await db.insert(agentWakeupRequests).values({ id: queueId, companyId: f.companyId, agentId: f.agentId,
      source: "automation", reason: "issue_commented", status: "deferred_issue_execution",
      requestedByActorType: "user", requestedByActorId: f.actorId, updatedAt: new Date(0),
      payload: { issueId: f.issueId, commentId: f.commentId, executionWait: { reason: "execution_recovery" },
        _paperclipWakeContext: { issueId: f.issueId, wakeReason: "issue_commented", wakeCommentIds: [f.commentId], wakeCommentId: f.commentId } },
    });
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({ savedMessageCount: 1, canContinue: true });
    await Promise.all([heartbeatService(db).resumeExecutionWaitComments(), heartbeatService(db).resumeExecutionWaitComments()]);
    await heartbeatService(db).resumeExecutionWaitComments();
    const runs = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.status, "queued")));
    expect(runs).toHaveLength(1);
    expect(runs[0].contextSnapshot).toMatchObject({ forceFreshSession: true, previousRunId: f.sourceRunId, wakeCommentIds: [f.commentId] });
    const [queue] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, queueId));
    expect(queue).toMatchObject({ status: "coalesced", runId: runs[0].id });
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
    const [source] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.sourceRunId));
    expect(source.resultJson).toEqual(resultJson);
  });

  it.each(["verified", "unproven", "changed", "dry_run", "retry", "duplicate"])(
    "requires exact local cleanup for a new turn after worker loss (%s)", async mode => {
      const f = await seed();
      await db.update(heartbeatRuns).set({ errorCode: "native_session_cleanup_quarantined" }).where(eq(heartbeatRuns.id, f.sourceRunId));
      const retire = vi.fn(() => mode !== "changed");
      const verify = vi.spyOn(nativeExecutor, "verifyStoppedNativeSessionForContinuation").mockResolvedValue(
        mode === "unproven" ? null : { evidence: { runId: f.sourceRunId, schema: "paperclip.stopped_native_conversation.v1" }, retire });
      try {
        const result = mode === "retry"
          ? await db.transaction(tx => admitExplicitNativeContinuation({ ...f, db: tx as unknown as typeof db,
              reason: "retry_failed_run", failedRunId: f.sourceRunId }))
          : await admit(f, mode === "dry_run");
        expect(Boolean(result)).toBe(["verified", "dry_run", "duplicate"].includes(mode));
        expect(retire).toHaveBeenCalledTimes(["verified", "changed", "duplicate"].includes(mode) ? 1 : 0);
        const actions = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
        expect(Boolean(actions[0].evidence.explicitUserContinuation)).toBe(["verified", "duplicate"].includes(mode));
        const events = await db.select().from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.runId, f.sourceRunId),
          eq(heartbeatRunEvents.eventType, "native.stopped_conversation_verified")));
        expect(events).toHaveLength(["verified", "duplicate"].includes(mode) ? 1 : 0);
        if (mode === "duplicate") {
          expect(await admit(f)).toBeNull();
          expect(retire).toHaveBeenCalledTimes(1);
        }
      } finally { verify.mockRestore(); }
    });

  it.each(["suspended", "ready", "wrong_run", "wrong_thread", "active_provider", "pending_tool", "pending_output", "missing_state", "new_launch"])(
    "recovers a historical run without process metadata only from exact suspended state (%s)", async kind => {
      const f = await seed();
      const stateBase = await mkdtemp(join(tmpdir(), "historical-native-followup-"));
      const previous = process.env.PAPERCLIP_RUNNER_STATE_DIR;
      process.env.PAPERCLIP_RUNNER_STATE_DIR = stateBase;
      try {
        const nativeSessionId = randomUUID(), runnerInstanceId = randomUUID();
        const execution = {
          schema: "paperclip.native-execution-input.v1", provider: { kind: "codex", model: null },
          binding: { companyId: f.companyId, issueId: f.issueId, agentId: f.agentId, runId: f.sourceRunId, executionWorkspaceId: "workspace" },
          task: { identifier: "TEST", title: "Continue", description: null, prompt: "Continue", workMode: "standard" },
          workspace: { cwd: stateBase, repoUrl: null, repoRef: null, branchName: null },
          session: { normalizedSessionId: nativeSessionId, driverKind: "codex_app_server", protocolVersion: 1, lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } },
          completionContract: { id: "contract", sha256: "sha", schemaVersion: "paperclip.completion-contract.v1",
            contract: { revision: "1", objective: "Continue", criteria: [{ id: "objective", requirement: "Continue" }] } },
          interactionResponses: [], credentialBindings: [],
        };
        await db.update(heartbeatRuns).set({ processPid: null, nativeSessionId, runnerInstanceId,
          errorCode: "native_runner_process_exited", runnerProfileJson: { nativeExecutionInput: execution,
            sessionCheckpoint: { sessionId: "exact-thread", providerSessionId: "backend-account" } },
        }).where(eq(heartbeatRuns.id, f.sourceRunId));
        const canonical = (value: unknown): string => value && typeof value === "object" && !Array.isArray(value)
          ? `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`
          : JSON.stringify(value);
        const root = join(stateBase, createHash("sha256").update(canonical({
          schema: "paperclip.native-session-scope.v2", companyId: f.companyId, agentId: f.agentId,
          workspace: { kind: "managed", executionWorkspaceId: "workspace" },
          provider: { driverKind: "codex_app_server", identity: { kind: "codex" } }, normalizedSessionId: nativeSessionId,
        })).digest("hex"));
        if (kind !== "missing_state") {
          await mkdir(join(root, "control-plane"), { recursive: true });
          await mkdir(join(root, "runner"), { recursive: true });
          const identity = { runId: kind === "wrong_run" ? randomUUID() : f.sourceRunId, runnerInstanceId,
            normalizedSessionId: nativeSessionId, environmentLeaseId: "workspace" };
          await writeFile(join(root, "control-plane/control-plane-state.json"), JSON.stringify({ schema: "paperclip.runner.durable.control-plane-state.v1", identity }));
          await writeFile(join(root, "runner/runner-state.json"), JSON.stringify({ schema: "paperclip.runner.durable.state.v1",
            ...identity, lifecycle: kind === "ready" ? "ready" : "suspended", outbox: kind === "pending_output" ? [{}] : [] }));
          await writeFile(join(root, "runner/codex-provider-state.json"), JSON.stringify({
            schema: "paperclip.runner.codex-provider-state.v1", lifecycle: "prepared",
            threadId: kind === "wrong_thread" ? "another-thread" : "exact-thread", providerSessionId: "backend-account",
            activeProviderTurnId: kind === "active_provider" ? "unfinished-turn" : null, ambiguousTurnStartPending: false,
            config: { provider: "codex", driver: "codex_app_server" }, pendingEvents: [], queuedEvents: [],
            toolBridge: { pending: kind === "pending_tool" ? { call: {} } : {} }, activeProviderResultFingerprint: null,
          }));
        }
        if (kind === "new_launch") await appendHeartbeatRunEvent(db, { companyId: f.companyId, runId: f.sourceRunId,
          agentId: f.agentId, eventType: PROCESS_START_REQUESTED });
        if (kind !== "suspended") {
          expect(await admit(f, true)).toBeNull();
          expect(await getExecutionBlocker(db, f.companyId, f.issueId)).not.toBeNull();
          return;
        }
        expect(await admit(f, true)).toMatchObject({ previousRunId: f.sourceRunId });
        expect(await getExecutionBlocker(db, f.companyId, f.issueId)).not.toBeNull();
        // Exercise the real message admission path while keeping the provider slot occupied.
        await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" });
        const heartbeat = heartbeatService(db);
        for (let n = 0; n < 2; n++) await heartbeat.wakeup(f.agentId, { source: "automation", triggerDetail: "system",
          reason: "issue_commented", requestedByActorType: "user", requestedByActorId: "board",
          payload: { issueId: f.issueId, commentId: f.commentId },
          contextSnapshot: { issueId: f.issueId, wakeCommentId: f.commentId } });
        const successors = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.status, "queued")));
        expect(successors).toHaveLength(1);
        expect(successors[0].contextSnapshot).toMatchObject({ previousRunId: f.sourceRunId, forceFreshSession: true, wakeCommentId: f.commentId });
        expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
        const [coordinator] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.sourceRunId));
        expect(coordinator).toMatchObject({ phase: "terminal_failure", attempt: 3 });
        const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
        expect(action.evidence.automaticRecovery).toMatchObject({ actionOutcome: "unknown", replay: "explicit_user_continuation" });
        expect(await hasNativeLocalProcessStop(db, f.companyId, f.sourceRunId)).toBe(false);
      } finally {
        if (previous === undefined) delete process.env.PAPERCLIP_RUNNER_STATE_DIR;
        else process.env.PAPERCLIP_RUNNER_STATE_DIR = previous;
        await rm(stateBase, { recursive: true, force: true });
      }
    },
  );
  async function seedCancelledStartup() {
    const f = await seed();
    await db.update(heartbeatRuns).set({ status: "cancelled", processPid: null,
      startedAt: new Date("2026-09-11T09:59:59Z"),
      runtimeModeResolvedAt: new Date("2026-09-11T10:00:01Z"),
      controllerBootId: randomUUID(), controllerLeaseExpiresAt: new Date("2026-09-11T10:01:00Z"),
    }).where(eq(heartbeatRuns.id, f.sourceRunId));
    await db.update(nativeRunFinalizations).set({ phase: "observed", attempt: 0,
      failureDetail: null,
    }).where(eq(nativeRunFinalizations.runId, f.sourceRunId));
    await db.insert(environmentLeases).values({ companyId: f.companyId, heartbeatRunId: f.sourceRunId,
      provider: "local", status: "released", releasedAt: new Date("2026-09-11T10:00:02Z"),
      cleanupStatus: "succeeded", leasePolicy: "ephemeral" });
    return f;
  }

  it.each(["never claimed", "operator stop", "dispatch event", "claimed", "unknown inventory", "completed inventory", "live preparer", "unreleased lease"] as const)(
    "proves no-dispatch dependency startup cancellation (%s)", async state => {
      const f = await seedCancelledStartup();
      const blockerId = randomUUID();
      await db.insert(issues).values({ id: blockerId, companyId: f.companyId, title: "Synthetic startup blocker",
        status: "done", completedAt: new Date("2026-09-11T12:00:00Z") });
      await db.insert(issueRelations).values({ companyId: f.companyId, issueId: blockerId,
        relatedIssueId: f.issueId, type: "blocks" });
      const receiptId = await recordDependencyClosureProof(db, { ...f, resolvedBlockerIssueId: blockerId, producer: "issue_update" });
      await db.update(heartbeatRuns).set({ resultJson: {
        startupCancellation: { beforeNativeSelection: false },
        ...(state === "operator stop" ? { cancellation: { source: "operator", expected: true,
          initiator: { type: "user" }, reason: "Stop", recordedAt: new Date().toISOString() } } : {}),
        ...(["unknown inventory", "completed inventory"].includes(state) ? { executionActionInventory: { schema: "paperclip.execution-actions.v1",
          source: "acp", complete: true, dispatch: "attempted", noActionsConfirmed: false,
          actions: [{ id: "uncertain-original", kind: "edit", status: state === "completed inventory" ? "completed" : "cancelled", outcome: state === "completed inventory" ? "completed" : "unknown" }] } } : {}),
      }, ...(state === "live preparer" ? { controllerLeaseExpiresAt: new Date(Date.now() + 60_000) } : {})
      }).where(eq(heartbeatRuns.id, f.sourceRunId));
      if (state === "dispatch event") await appendHeartbeatRunEvent(db, { companyId: f.companyId,
        runId: f.sourceRunId, agentId: f.agentId, eventType: PROCESS_START_REQUESTED, stream: "system", level: "info", message: "Synthetic launch request" });
      if (state === "claimed") await db.update(nativeRunFinalizations).set({ attempt: 1 }).where(eq(nativeRunFinalizations.runId, f.sourceRunId));
      if (state === "unreleased lease") await db.update(environmentLeases).set({ releasedAt: null, status: "active" }).where(eq(environmentLeases.heartbeatRunId, f.sourceRunId));
      const input = { ...f, db, reason: "issue_blockers_resolved", commentId: null, receiptId };
      const dry = await db.transaction(tx => admitDependencyClosureContinuation({ ...input, db: tx as unknown as typeof db, dryRun: true }));
      expect(await getExecutionBlocker(db, f.companyId, f.issueId)).not.toBeNull();
      if (state !== "never claimed") { expect(dry).toBeNull(); return; }
      expect(dry).toMatchObject({ previousRunId: f.sourceRunId });
      await db.transaction(async tx => {
        expect(await admitDependencyClosureContinuation({ ...input, db: tx as unknown as typeof db })).toMatchObject({ previousRunId: f.sourceRunId });
        await tx.insert(heartbeatRuns).values({ id: f.successorRunId, companyId: f.companyId, agentId: f.agentId,
          status: "queued", contextSnapshot: { issueId: f.issueId, previousRunId: f.sourceRunId, forceFreshSession: true } });
      });
      expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.sourceRunId)))[0].resultJson).toEqual({ startupCancellation: { beforeNativeSelection: false } });
      expect(await db.transaction(tx => admitDependencyClosureContinuation({ ...input, db: tx as unknown as typeof db }))).toBeNull();
    },
  );

  it("settles a cancelled unclaimed coordinator after restart and admits one user successor", async () => {
    const f = await seedCancelledStartup();
    expect(await admit(f, true)).toMatchObject({ previousRunId: f.sourceRunId });
    expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.sourceRunId)))[0].phase).toBe("observed");
    const results = await Promise.all([admit(f), admit(f)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const [coordinator] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.sourceRunId));
    expect(coordinator).toMatchObject({ phase: "terminal_failure", attempt: 0,
      failureCode: "native_startup_cancelled", failureDetail: { replacementDenied: "explicit_user_continuation" } });
    const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    expect(action.evidence.automaticRecovery).toMatchObject({ actionOutcome: "unknown", replay: "explicit_user_continuation" });
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.sourceRunId)))[0].status).toBe("cancelled");
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.successorRunId))).toHaveLength(1);
  });

  it("continues native-runner preparation cancelled before runtime selection", async () => {
    const f = await seedCancelledStartup();
    await db.delete(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.sourceRunId));
    await db.update(heartbeatRuns).set({ runtimeMode: "legacy", runtimeModeResolvedAt: null, nativeIssueId: null,
      runnerProfileJson: { adapterDispatch: { adapterType: "paperclip_runner" } },
      resultJson: { startupCancellation: { beforeNativeSelection: true }, startupPreparationSettledAt: new Date().toISOString() },
    }).where(eq(heartbeatRuns.id, f.sourceRunId));
    expect(await admit(f)).toMatchObject({ previousRunId: f.sourceRunId });
  });

  async function seedHistoricalCancelledPreparation(retainedReceipt = false) {
    const f = await seedCancelledStartup();
    await db.delete(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.sourceRunId));
    await db.delete(environmentLeases).where(eq(environmentLeases.heartbeatRunId, f.sourceRunId));
    await db.update(heartbeatRuns).set({ runtimeMode: "legacy", runtimeModeResolvedAt: null,
      nativeIssueId: null, nativeSessionId: null, executionStage: "preparing", errorCode: "operator_interrupted",
      runnerProfileJson: { adapterDispatch: { adapterType: "paperclip_runner" } },
      resultJson: retainedReceipt ? { operatorInterrupted: true, stopReason: "cancelled",
        startupCancellation: { beforeNativeSelection: true, requestedAt: "2026-09-11T10:00:00Z" } } : null,
    }).where(eq(heartbeatRuns.id, f.sourceRunId));
    await db.update(issueRecoveryActions).set({ cause: "legacy_execution_requires_reconciliation" })
      .where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    return f;
  }

  it("records suppression at actual handoff, completes cleanup and runs one normal successor", async () => {
    const f = await seed();
    await db.delete(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.sourceRunId));
    await db.delete(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, f.sourceRunId));
    await db.update(agents).set({ adapterType: "codex_local", adapterConfig: { cwd: "/tmp" } }).where(eq(agents.id, f.agentId));
    await db.update(issues).set({ status: "todo", responsibleUserId: "board" }).where(eq(issues.id, f.issueId));
    const originalRecovery = recoveryModule.recoveryService;
    let suppressed = false;
    const recoveryFactory = vi.spyOn(recoveryModule, "recoveryService").mockImplementation((...args) => {
      const service = originalRecovery(...args);
      return { ...service, legacyRepairDispatchBlock: async runId => {
        if (!suppressed) { suppressed = true; return "recorded_disposition"; }
        return service.legacyRepairDispatchBlock(runId);
      } };
    });
    const execution = vi.spyOn(getServerAdapter("codex_local"), "execute").mockImplementation(async context => {
      await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId,
        authorType: "agent", authorAgentId: f.agentId, createdByRunId: context.runId, body: "Normal successor completed." });
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.issueId));
      return { exitCode: 0, signal: null, timedOut: false };
    });
    const heartbeat = heartbeatService(db);
    try {
      const repair = await heartbeat.wakeup(f.agentId, { source: "assignment", reason: "issue_assigned",
        payload: { issueId: f.issueId }, contextSnapshot: { issueId: f.issueId } });
      await heartbeat.drainActiveRunExecutions();
      const [cancelled] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, repair!.id));
      expect(cancelled).toMatchObject({ status: "cancelled", errorCode: "legacy_disposition_repair_suppressed",
        resultJson: { dispositionSuppression: { reason: "recorded_disposition", providerDispatchStarted: false } } });
      expect(execution).not.toHaveBeenCalled();
      expect(await isLegacyDispositionSuppressionVerified(db, cancelled)).toBe(true);
      expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
      await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, f.issueId));
      const wake = { source: "automation", reason: "issue_continuation_needed", idempotencyKey: `normal:${repair!.id}`,
        requestedByActorType: "agent", requestedByActorId: f.agentId, payload: { issueId: f.issueId },
        contextSnapshot: { issueId: f.issueId, forceFreshSession: true } } as const;
      await heartbeat.wakeup(f.agentId, wake);
      await heartbeat.drainActiveRunExecutions();
      // Repeated cleanup cannot enqueue another successor.
      expect(await settleLegacyDispositionSuppression(db, { run: cancelled, providerDispatchStarted: false })).not.toBeNull();
      await heartbeat.drainActiveRunExecutions();
      expect(execution).toHaveBeenCalledTimes(1);
      const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId));
      expect(runs).toHaveLength(2);
      expect(runs.filter(run => run.status === "succeeded")).toHaveLength(1);
    } finally { await heartbeat.drainActiveRunExecutions(); recoveryFactory.mockRestore(); execution.mockRestore(); }
  });

  async function seedSuppressedDisposition() {
    const f = await seedCancelledReviewWait();
    const [before] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.sourceRunId));
    const resultJson = { dispositionSuppression: dispositionSuppressionReceipt(before, "recorded_disposition"),
      cancellation: { source: "control_plane", expected: true, initiator: { type: "system" },
        reason: "Disposition repair suppressed before provider dispatch", recordedAt: new Date().toISOString() },
      recordedDisposition: { outcome: "waiting_for_review" } };
    const [run] = await db.update(heartbeatRuns).set({ errorCode: "legacy_disposition_repair_suppressed",
      executionStage: "settled", startedAt: new Date(Date.now() - 1000), finishedAt: new Date(), resultJson,
    }).where(eq(heartbeatRuns.id, f.sourceRunId)).returning();
    await db.update(issueRecoveryActions).set({ fingerprint: `legacy-execution:${run.id}` })
      .where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    await db.update(issues).set({ status: "in_progress", executionRunId: null, checkoutRunId: null })
      .where(eq(issues.id, f.issueId));
    return { ...f, run };
  }

  it.each(["valid", "missing receipt", "wrong run", "dispatch flag", "adapter entered", "provider event", "tool event", "tool.execution.completed", "tool.execution.progress", "tool.execution.failed", "launch", "process", "controller", "session", "native coordinator", "active lease", "failed cleanup", "missing cleanup", "remote unverified", "workspace", "hold workspace", "operator", "completed actions", "unknown inventory", "pending tools", "provider started", "local provider resource"])(
    "qualifies suppressed disposition cleanup (%s)", async kind => {
      const f = await seedSuppressedDisposition();
      let result = f.run.resultJson!;
      if (kind === "missing receipt") result = { ...result, dispositionSuppression: null };
      if (kind === "wrong run") result = { ...result, dispositionSuppression: { ...result.dispositionSuppression as object, runId: randomUUID() } };
      if (kind === "dispatch flag") result = { ...result, dispositionSuppression: { ...result.dispositionSuppression as object, providerDispatchStarted: true } };
      if (kind === "workspace") result = { ...result, workspaceRestoreFailure: "restore_unsafe_archive" };
      if (kind === "operator") result = { ...result, cancellation: { ...result.cancellation as object, source: "operator" } };
      if (kind === "pending tools") result = { ...result, acpPendingToolCount: 1 };
      if (kind === "provider started") result = { ...result, executionRecovery: { providerWorkStarted: true } };
      if (kind === "unknown inventory") result = { ...result, executionActionInventory: { complete: false } };
      if (kind === "completed actions") result = { ...result, executionActionInventory: {
        schema: "paperclip.execution-actions.v1", source: "acp", complete: true, dispatch: "attempted", noActionsConfirmed: false,
        actions: [{ id: "original-effect", kind: "edit", status: "completed", outcome: "completed" }],
      } };
      await db.update(heartbeatRuns).set({ resultJson: result,
        ...(kind === "process" ? { processPid: 123 } : {}),
        ...(kind === "controller" ? { controllerLeaseExpiresAt: new Date(Date.now() + 60000) } : {}),
        ...(kind === "session" ? { sessionIdAfter: "provider-session" } : {}),
      }).where(eq(heartbeatRuns.id, f.sourceRunId));
      if (["provider event", "tool event", "launch"].includes(kind) || kind.startsWith("tool.execution.")) await appendHeartbeatRunEvent(db, {
        companyId: f.companyId, runId: f.sourceRunId, agentId: f.agentId,
        eventType: kind.startsWith("tool.execution.") ? kind : kind === "launch" ? PROCESS_START_REQUESTED : kind === "tool event" ? "tool.execution.started" : "provider.event",
      });
      if (kind === "native coordinator") {
        await db.update(heartbeatRuns).set({ nativeIssueId: f.issueId }).where(eq(heartbeatRuns.id, f.sourceRunId));
        await db.insert(nativeRunFinalizations).values({ companyId: f.companyId,
          runId: f.sourceRunId, issueId: f.issueId, phase: "observed", attempt: 0 });
      }
      if (["valid", "active lease", "failed cleanup", "missing cleanup", "remote unverified", "local provider resource"].includes(kind)) await db.insert(environmentLeases).values({
        companyId: f.companyId, heartbeatRunId: f.sourceRunId, provider: kind === "remote unverified" ? "daytona" : "local",
        providerLeaseId: kind === "local provider resource" ? "unexpected-sandbox" : null,
        status: kind === "active lease" ? "active" : "released", releasedAt: kind === "active lease" ? null : new Date(),
        cleanupStatus: kind === "failed cleanup" ? "failed" : kind === "missing cleanup" ? null : "success",
      });
      if (kind === "hold workspace") await db.update(issueRecoveryActions).set({ evidence: {
        runId: f.sourceRunId, workspaceRestoreFailure: "restore_unsafe_archive", automaticRecovery: { replay: "blocked" },
      } }).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.sourceRunId));
      expect(await isLegacyDispositionSuppressionVerified(db, run)).toBe(false); // cleanup receipt not yet committed
      const settled = await settleLegacyDispositionSuppression(db, { run, providerDispatchStarted: kind === "adapter entered" });
      const [hold] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
      if (kind !== "valid") {
        expect(settled).toBeNull();
        expect(await getExecutionBlocker(db, f.companyId, f.issueId)).not.toBeNull();
        expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.sourceRunId)))[0].resultJson).toEqual(result);
        return;
      }
      expect(settled).not.toBeNull();
      expect(await legacyExecutionNeedsReconciliationWithEvidence(db, settled!)).toBe(false);
      expect(hold).toMatchObject({ status: "resolved", outcome: "false_positive",
        evidence: { automaticRecovery: { replay: "allowed", actionOutcome: "unknown" } } });
      expect(settled!.resultJson).toMatchObject({ recordedDisposition: result.recordedDisposition });
      expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
    });

  it.each(["ready", "dependency", "paused agent", "review", "task pause"])("normal successor after verified suppression respects %s", async gate => {
    const f = await seedSuppressedDisposition();
    const heartbeat = heartbeatService(db);
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" });
    if (gate === "dependency") {
      const id = randomUUID();
      await db.insert(issues).values({ id, companyId: f.companyId, title: "Required review", status: "todo" });
      await db.insert(issueRelations).values({ companyId: f.companyId, issueId: id, relatedIssueId: f.issueId, type: "blocks" });
    }
    if (gate === "paused agent") await db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.agentId));
    if (gate === "review") await db.update(agents).set({ adapterType: "codex_local", adapterConfig: { cwd: "/tmp" } }).where(eq(agents.id, f.agentId));
    if (gate === "review") await db.update(issues).set({ status: "in_review", executionState: {
      status: "pending", currentStageId: randomUUID(), currentStageIndex: 0, currentStageType: "review",
      currentParticipant: { type: "agent", agentId: randomUUID(), userId: null },
      returnAssignee: { type: "agent", agentId: f.agentId, userId: null }, completedStageIds: [],
      lastDecisionId: null, lastDecisionOutcome: null, monitor: null,
    } }).where(eq(issues.id, f.issueId));
    if (gate === "task pause") {
      const holdId = randomUUID();
      await db.insert(issueTreeHolds).values({ id: holdId, companyId: f.companyId, rootIssueId: f.issueId, mode: "pause", status: "active" });
      await db.insert(issueTreeHoldMembers).values({ companyId: f.companyId, holdId, issueId: f.issueId, depth: 0, issueTitle: "Deploy", issueStatus: "in_progress" });
    }
    expect(await settleLegacyDispositionSuppression(db, { run: f.run, providerDispatchStarted: false })).not.toBeNull();
    for (let n = 0; n < 2; n++) {
      const wake = heartbeat.wakeup(f.agentId, { source: "automation", reason: "issue_continuation_needed",
        idempotencyKey: `suppressed:${f.sourceRunId}`,
        requestedByActorType: "agent", requestedByActorId: f.agentId,
        payload: { issueId: f.issueId }, contextSnapshot: { issueId: f.issueId, forceFreshSession: true } });
      if (gate === "paused agent") await expect(wake).rejects.toThrow("Agent is not invokable");
      else await wake;
    }
    const successors = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.status, "queued")));
    // Review can reserve a queued run, but dispatch must reject the executor
    // while another participant owns the stage.
    expect(successors).toHaveLength(["ready", "review"].includes(gate) ? 1 : 0);
    if (gate === "ready") expect(successors[0].contextSnapshot).toMatchObject({ forceFreshSession: true });
    if (gate === "review") {
      await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(and(
        eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.status, "running")));
      const execution = vi.spyOn(getServerAdapter("codex_local"), "execute").mockResolvedValue({ exitCode: 0, signal: null, timedOut: false });
      try {
        await heartbeat.resumeQueuedRunsForAgent(f.companyId, f.agentId);
        await heartbeat.drainActiveRunExecutions();
        const [rejected] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, successors[0].id));
        expect(rejected).toMatchObject({ status: "cancelled", errorCode: "issue_review_participant_changed" });
        expect(execution).not.toHaveBeenCalled();
      } finally { await heartbeat.drainActiveRunExecutions(); execution.mockRestore(); }
    }
  });

  async function seedCancelledReviewWait() {
    const f = await seedHistoricalCancelledPreparation();
    await db.update(heartbeatRuns).set({ startedAt: null, executionStage: null,
      controllerBootId: null, controllerLeaseExpiresAt: null, runnerProfileJson: null,
      errorCode: "issue_continuation_waiting_on_review",
      resultJson: { stopReason: "issue_continuation_waiting_on_review", timeoutSource: "stale_queued_run_gate" },
    }).where(eq(heartbeatRuns.id, f.sourceRunId));
    return f;
  }

  it("keeps provider diagnostics out of admission evidence and preserves absent results", async () => {
    const f = await seedCancelledReviewWait();
    const heartbeat = heartbeatService(db);
    await db.update(heartbeatRuns).set({ resultJson: {
      stopReason: "issue_continuation_waiting_on_review", timeoutSource: "stale_queued_run_gate",
      summary: "private provider output", providerPayload: "large provider output".repeat(10000),
    } }).where(eq(heartbeatRuns.id, f.sourceRunId));
    const projected = await heartbeat.getRun(f.sourceRunId, { includeExecutionEvidence: true });
    expect(projected?.resultJson).toMatchObject({ stopReason: "issue_continuation_waiting_on_review", timeoutSource: "stale_queued_run_gate" });
    expect(projected?.resultJson).not.toHaveProperty("summary");
    expect(projected?.resultJson).not.toHaveProperty("providerPayload");
    await db.update(heartbeatRuns).set({ resultJson: null }).where(eq(heartbeatRuns.id, f.sourceRunId));
    expect((await heartbeat.getRun(f.sourceRunId, { includeExecutionEvidence: true }))?.resultJson).toBeNull();
    await db.update(heartbeatRuns).set({ resultJson: { unrecognizedReceipt: true } }).where(eq(heartbeatRuns.id, f.sourceRunId));
    expect((await heartbeat.getRun(f.sourceRunId, { includeExecutionEvidence: true }))?.resultJson).not.toBeNull();
  });

  it.each([false, true].flatMap(ascii => ["message", "retry"].map(kind => ({ ascii, kind }))))(
    "recovers a pre-dispatch review wait through an explicit $kind (SQL_ASCII: $ascii)", async ({ ascii, kind }) => {
    const f = await seedCancelledReviewWait();
    const heartbeat = heartbeatService(db);
    if (ascii) {
      const encoding = vi.spyOn(db, "execute").mockResolvedValueOnce([{ server_encoding: "SQL_ASCII" }] as never);
      try { expect((await heartbeat.getRun(f.sourceRunId))?.resultJson).toBeNull(); }
      finally { encoding.mockRestore(); }
    }
    const notice = await getExecutionBlocker(db, f.companyId, f.issueId);
    expect(notice).toMatchObject({ canRetry: true, runError: "Waiting for review; this continuation never started." });
    expect(notice?.nextAction).not.toContain("Inspect the run before sending a new message");
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" });
    const successor = await heartbeat.wakeup(f.agentId, { source: kind === "retry" ? "on_demand" : "automation", triggerDetail: "manual",
      reason: kind === "retry" ? "retry_failed_run" : "issue_commented",
      ...(kind === "retry" ? { failedRunId: f.sourceRunId } : {}), requestedByActorType: "user", requestedByActorId: "board",
      payload: { issueId: f.issueId, ...(kind === "message" ? { commentId: f.commentId } : {}) },
      contextSnapshot: { issueId: f.issueId, ...(kind === "message" ? { wakeCommentId: f.commentId } : {}) },
    });
    expect(successor).toMatchObject({ status: "queued", contextSnapshot: { forceFreshSession: true,
      previousRunId: f.sourceRunId, explicitUserContinuation: { commentId: kind === "message" ? f.commentId : null } } });
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.sourceRunId)))[0].status).toBe("cancelled");
  });

  it.each([false, true])("reconsiders saved input after a pre-dispatch review wait exactly once (SQL_ASCII: %s)", async ascii => {
    const f = await seedCancelledReviewWait();
    const heartbeat = heartbeatService(db);
    if (ascii) {
      const encoding = vi.spyOn(db, "execute").mockResolvedValueOnce([{ server_encoding: "SQL_ASCII" }] as never);
      try { expect((await heartbeat.getRun(f.sourceRunId))?.resultJson).toBeNull(); }
      finally { encoding.mockRestore(); }
    }
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" });
    const leaseId = randomUUID();
    await db.insert(environmentLeases).values({ id: leaseId, companyId: f.companyId,
      heartbeatRunId: f.sourceRunId, provider: "local", status: "pending_cleanup", cleanupStatus: "failed" });
    await heartbeat.wakeup(f.agentId, { source: "automation", reason: "issue_commented",
      requestedByActorType: "user", requestedByActorId: "board", payload: { issueId: f.issueId, commentId: f.commentId },
      contextSnapshot: { issueId: f.issueId, wakeCommentId: f.commentId } });
    const [waiting] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId));
    expect(waiting.status).toBe("deferred_issue_execution");
    await db.update(environmentLeases).set({ status: "released", releasedAt: new Date(), cleanupStatus: "succeeded" })
      .where(eq(environmentLeases.id, leaseId));
    await db.update(agentWakeupRequests).set({ updatedAt: new Date(0) }).where(eq(agentWakeupRequests.id, waiting.id));
    await Promise.all([heartbeat.resumeExecutionWaitComments(), heartbeat.resumeExecutionWaitComments()]);
    const successors = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.status, "queued")));
    expect(successors).toHaveLength(1);
    expect(successors[0].contextSnapshot).toMatchObject({ wakeCommentIds: [f.commentId],
      explicitUserContinuation: { commentId: f.commentId }, forceFreshSession: true });
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, waiting.id)))[0])
      .toMatchObject({ status: "coalesced", runId: successors[0].id });
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
  });

  it.each(["launch", "provider", "cleanup"])("retains a pre-dispatch review wait with contradictory %s evidence", async kind => {
    const f = await seedCancelledReviewWait();
    if (kind === "cleanup") await db.insert(environmentLeases).values({ companyId: f.companyId,
      heartbeatRunId: f.sourceRunId, provider: "local", status: "pending_cleanup", cleanupStatus: "failed" });
    else await db.insert(heartbeatRunEvents).values({ companyId: f.companyId, runId: f.sourceRunId,
      agentId: f.agentId, seq: 1, eventType: kind === "launch" ? PROCESS_START_REQUESTED : "provider.event",
      stream: "system", level: "info", message: "Contradictory execution evidence" });
    try {
      expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({ canRetry: false });
      expect(await admit(f)).toBeNull();
    } finally {
      await db.delete(environmentLeases).where(eq(environmentLeases.heartbeatRunId, f.sourceRunId));
    }
  });

  it.each([false, true].flatMap(receipt => ["message", "retry"].map(kind => ({ receipt, kind }))))(
    "recovers historical native preparation through an explicit $kind (receipt: $receipt)", async ({ receipt, kind }) => {
    const f = await seedHistoricalCancelledPreparation(receipt);
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({ canRetry: true });
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" });
    const successor = await heartbeatService(db).wakeup(f.agentId, {
      source: "on_demand", triggerDetail: "manual", reason: kind === "retry" ? "retry_failed_run" : "issue_commented",
      ...(kind === "retry" ? { failedRunId: f.sourceRunId } : {}), requestedByActorType: "user", requestedByActorId: "board",
      payload: { issueId: f.issueId, ...(kind === "message" ? { commentId: f.commentId } : {}) },
      contextSnapshot: { issueId: f.issueId, ...(kind === "message" ? { wakeCommentId: f.commentId } : {}) },
    });
    expect(successor).toMatchObject({ status: "queued", contextSnapshot: { forceFreshSession: true,
      previousRunId: f.sourceRunId, explicitUserContinuation: { commentId: kind === "message" ? f.commentId : null } } });
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
    const [source] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.sourceRunId));
    expect(source).toMatchObject({ status: "cancelled", runtimeMode: "legacy",
      resultJson: receipt ? { startupCancellation: { beforeNativeSelection: true } } : null });
  });

  it.each([false, true].flatMap(receipt => ["fresh", "earlier_delivered", "last_delivered"].map(kind => ({ receipt, kind }))))(
    "resumes saved input after historical native preparation expires across restart exactly once ($kind, receipt: $receipt)", async ({ receipt, kind }) => {
    const f = await seedHistoricalCancelledPreparation(receipt);
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" });
    await db.update(heartbeatRuns).set({ controllerLeaseExpiresAt: new Date(Date.now() + 60_000) })
      .where(eq(heartbeatRuns.id, f.sourceRunId));
    await heartbeatService(db).wakeup(f.agentId, { source: "automation", reason: "issue_commented",
      requestedByActorType: "user", requestedByActorId: "board", payload: { issueId: f.issueId, commentId: f.commentId },
      contextSnapshot: { issueId: f.issueId, wakeCommentId: f.commentId } });
    const [waiting] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId));
    expect(waiting.status).toBe("deferred_issue_execution");
    if (kind !== "fresh") {
      const deliveredId = randomUUID();
      await db.insert(issueComments).values({ id: deliveredId, companyId: f.companyId, issueId: f.issueId,
        authorType: "user", authorUserId: "another-author", body: "Already handled",
        createdAt: new Date(kind === "earlier_delivered" ? "2026-09-11T10:30:00Z" : "2026-09-11T11:30:00Z") });
      await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "succeeded",
        startedAt: new Date("2026-09-11T12:00:00Z"), finishedAt: new Date("2026-09-11T12:01:00Z"),
        contextSnapshot: { issueId: f.issueId, wakeCommentIds: [deliveredId] } });
      await db.update(agentWakeupRequests).set({ payload: { ...waiting.payload,
        _paperclipWakeContext: { wakeCommentIds: kind === "earlier_delivered" ? [deliveredId, f.commentId] : [f.commentId, deliveredId] } },
      }).where(eq(agentWakeupRequests.id, waiting.id));
    }
    await db.update(heartbeatRuns).set({ controllerLeaseExpiresAt: new Date(0) })
      .where(eq(heartbeatRuns.id, f.sourceRunId));
    await db.update(agentWakeupRequests).set({ updatedAt: new Date(0) }).where(eq(agentWakeupRequests.id, waiting.id));
    await Promise.all([heartbeatService(db).resumeExecutionWaitComments(), heartbeatService(db).resumeExecutionWaitComments()]);
    const successors = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.status, "queued")));
    expect(successors).toHaveLength(1);
    expect(successors[0].contextSnapshot).toMatchObject({ wakeCommentIds: [f.commentId],
      explicitUserContinuation: { commentId: f.commentId }, forceFreshSession: true });
    const [queueReceipt] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, waiting.id));
    expect(queueReceipt).toMatchObject({ status: "coalesced", runId: successors[0].id });
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
  });

  it.each([false, true].flatMap(receipt => ["resolved", "dispatching", "adapter", "missing_boot", "current_boot", "missing_lease", "live_lease", "receipt", "launch", "invoked", "coordinator", "cleanup", "remote"].map(kind => ({ receipt, kind }))))(
    "holds historical native preparation with contradictory or incomplete $kind evidence (receipt: $receipt)", async ({ receipt, kind }) => {
      const f = await seedHistoricalCancelledPreparation(receipt);
      const patch = kind === "resolved" ? { runtimeModeResolvedAt: new Date() }
        : kind === "dispatching" ? { executionStage: "dispatching" }
        : kind === "adapter" ? { runnerProfileJson: { adapterDispatch: { adapterType: "process" } } }
        : kind === "missing_boot" ? { controllerBootId: null }
        : kind === "current_boot" ? { controllerBootId: legacyControllerBootId }
        : kind === "missing_lease" ? { controllerLeaseExpiresAt: null }
        : kind === "live_lease" ? { controllerLeaseExpiresAt: new Date(Date.now() + 60_000) }
        : kind === "receipt" ? { resultJson: { startupCancellation: { beforeNativeSelection: false } } } : {};
      if (Object.keys(patch).length) await db.update(heartbeatRuns).set(patch).where(eq(heartbeatRuns.id, f.sourceRunId));
      if (kind === "launch" || kind === "invoked") await db.insert(heartbeatRunEvents).values({ companyId: f.companyId,
        agentId: f.agentId, runId: f.sourceRunId, seq: 1,
        eventType: kind === "launch" ? PROCESS_START_REQUESTED : "adapter.invoke", payload: { adapterType: "paperclip_runner" } });
      if (kind === "coordinator") {
        await db.update(heartbeatRuns).set({ nativeIssueId: f.issueId }).where(eq(heartbeatRuns.id, f.sourceRunId));
        await db.insert(nativeRunFinalizations).values({ companyId: f.companyId,
          runId: f.sourceRunId, issueId: f.issueId, phase: "observed", attempt: 0 });
      }
      if (kind === "cleanup" || kind === "remote") await db.insert(environmentLeases).values({ companyId: f.companyId,
        heartbeatRunId: f.sourceRunId, provider: kind === "remote" ? "daytona" : "local",
        providerLeaseId: kind === "remote" ? "unverified" : null, leasePolicy: "ephemeral",
        status: "pending_cleanup", cleanupStatus: "failed" });
      expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({ canRetry: false });
      expect(await admit(f)).toBeNull();
      // Later tests exercise the global cleanup sweep with their own retry
      // counters. Do not leave this negative fixture as another cleanup target.
      await db.delete(environmentLeases).where(eq(environmentLeases.heartbeatRunId, f.sourceRunId));
    },
  );

  it.each(["attempt", "generation", "controller", "lease", "process", "launch", "provider", "cleanup", "remote", "preparing", "closed", "reassigned"])(
    "retains cancellation safeguards with %s evidence", async kind => {
      const f = await seedCancelledStartup();
      if (kind === "attempt") await db.update(nativeRunFinalizations).set({ attempt: 1 }).where(eq(nativeRunFinalizations.runId, f.sourceRunId));
      if (kind === "generation") await db.update(nativeRunFinalizations).set({ controllerGeneration: 1 }).where(eq(nativeRunFinalizations.runId, f.sourceRunId));
      if (kind === "controller") await db.update(nativeRunFinalizations).set({ controllerBootId: "old-owner" }).where(eq(nativeRunFinalizations.runId, f.sourceRunId));
      if (kind === "lease") await db.update(nativeRunFinalizations).set({ leaseOwner: "owner", leaseExpiresAt: new Date(Date.now() + 60000) }).where(eq(nativeRunFinalizations.runId, f.sourceRunId));
      if (kind === "process") await db.update(heartbeatRuns).set({ processPid: process.pid }).where(eq(heartbeatRuns.id, f.sourceRunId));
      if (kind === "launch" || kind === "provider") await db.insert(heartbeatRunEvents).values({ companyId: f.companyId,
        agentId: f.agentId, runId: f.sourceRunId, seq: 1,
        eventType: kind === "launch" ? PROCESS_START_REQUESTED : "provider.event",
        ...(kind === "provider" ? { sourceEventId: "provider-1", sourceInstanceId: "provider", sourceSeq: 1, protocolSchemaVersion: 1, canonicalPayloadHash: "hash" } : {}),
      });
      if (kind === "cleanup") await db.update(environmentLeases).set({ status: "pending_cleanup", cleanupStatus: "failed" }).where(eq(environmentLeases.heartbeatRunId, f.sourceRunId));
      if (kind === "remote") await db.update(environmentLeases).set({ provider: "daytona", providerLeaseId: "unverified" }).where(eq(environmentLeases.heartbeatRunId, f.sourceRunId));
      if (kind === "preparing") await db.update(heartbeatRuns).set({ controllerLeaseExpiresAt: new Date(Date.now() + 60000) }).where(eq(heartbeatRuns.id, f.sourceRunId));
      if (kind === "closed") await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.issueId));
      if (kind === "reassigned") await db.update(issues).set({ assigneeAgentId: null }).where(eq(issues.id, f.issueId));
      expect(await admit(f)).toBeNull();
      expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.sourceRunId)))[0].phase).toBe("observed");
      await db.delete(environmentLeases).where(eq(environmentLeases.heartbeatRunId, f.sourceRunId));
    },
  );

  it("preserves local stop proof after process metadata is cleared and invalidates it on another launch", async () => {
    const f = await seed();
    const [source] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.sourceRunId));
    await db.transaction(async tx => {
      expect(await recordNativeLocalProcessStop(tx as unknown as typeof db, source)).toBe(true);
      await tx.update(heartbeatRuns).set({ processPid: null }).where(eq(heartbeatRuns.id, source.id));
    });
    expect(await hasNativeLocalProcessStop(db, f.companyId, source.id)).toBe(true);
    expect(await hasNativeLocalProcessStop(db, randomUUID(), source.id)).toBe(false);
    expect(await admit(f, true)).toMatchObject({ previousRunId: source.id });
    await persistHeartbeatRunProcessMetadata(db, source.id, { pid: 999999999, processGroupId: null, startedAt: new Date().toISOString() });
    await db.update(heartbeatRuns).set({ processPid: null }).where(eq(heartbeatRuns.id, source.id));
    expect(await admit(f, true)).toBeNull();
    expect(await recordNativeLocalProcessStop(db, source)).toBe(true);
    await appendHeartbeatRunEvent(db, { companyId: f.companyId, runId: source.id, agentId: f.agentId,
      eventType: PROCESS_START_REQUESTED });
    // No PID was stored for the new launch, as when the server dies after spawn.
    expect(await admit(f, true)).toBeNull();
  });

  it.each(["live", "remote", "provider_event"])("does not accept invalid local stop proof: %s", async kind => {
    const f = await seed();
    if (kind === "remote") {
      const [environment] = await db.insert(environments).values({ name: "Remote stop", driver: "sandbox" }).returning();
      await db.insert(environmentLeases).values({ companyId: f.companyId, heartbeatRunId: f.sourceRunId,
        environmentId: environment.id, provider: "daytona", status: "active", leasePolicy: "ephemeral" });
    }
    if (kind === "live") await db.update(heartbeatRuns).set({ processPid: process.pid }).where(eq(heartbeatRuns.id, f.sourceRunId));
    const [source] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.sourceRunId));
    if (kind === "provider_event") {
      await db.insert(heartbeatRunEvents).values({ companyId: f.companyId, runId: source.id, agentId: f.agentId,
        eventType: "native.local_process_stopped", seq: 1, sourceEventId: randomUUID() });
    } else expect(await recordNativeLocalProcessStop(db, source)).toBe(false);
    expect(await hasNativeLocalProcessStop(db, f.companyId, source.id)).toBe(false);
  });

  it.each(["stopped_process", "cancelled_startup"])("resumes saved local messages after restart exactly once: %s", async kind => {
    const f = kind === "cancelled_startup" ? await seedCancelledStartup() : await seed();
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" });
    await db.update(heartbeatRuns).set({ processPid: process.pid }).where(eq(heartbeatRuns.id, f.sourceRunId));
    // A prior cancelled admission is also held, but cannot select the native
    // retry source. The newest blocker must win just as it does on Send.
    const oldAdmissionId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: oldAdmissionId, companyId: f.companyId, agentId: f.agentId,
      status: "cancelled", errorCode: "execution_reconciliation_required", contextSnapshot: { issueId: f.issueId },
      finishedAt: new Date("2026-09-11T09:00:00Z") });
    await db.update(issueRecoveryActions).set({ updatedAt: new Date(0), evidence: { runId: oldAdmissionId,
      automaticRecovery: { replay: "blocked", actionOutcome: "unknown" } } }).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.issueId,
      kind: "active_run_watchdog", cause: "uncertain_external_action", fingerprint: randomUUID(), status: "active",
      nextAction: "Waiting for the current run.", evidence: { runId: f.sourceRunId } });
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({ runId: f.sourceRunId });
    await heartbeatService(db).wakeup(f.agentId, { source: "automation", triggerDetail: "system", reason: "issue_commented",
      requestedByActorType: "user", requestedByActorId: "board", payload: { issueId: f.issueId, commentId: f.commentId },
      contextSnapshot: { issueId: f.issueId, wakeCommentId: f.commentId } });
    const [waiting] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId));
    expect(waiting.payload?.executionWait).toMatchObject({ reason: kind === "cancelled_startup" ? "controller_settling" : "process_running" });
    const makeDue = () => db.update(agentWakeupRequests).set({ updatedAt: new Date(0) }).where(eq(agentWakeupRequests.id, waiting.id));
    await makeDue();
    await heartbeatService(db).resumeExecutionWaitComments();
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toHaveLength(1);
    await db.update(heartbeatRuns).set({ processPid: 999999999 }).where(eq(heartbeatRuns.id, f.sourceRunId));
    const [stopped] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.sourceRunId));
    await db.transaction(async tx => {
      await recordNativeLocalProcessStop(tx as unknown as typeof db, stopped);
      await tx.update(heartbeatRuns).set({ processPid: null }).where(eq(heartbeatRuns.id, stopped.id));
    });
    const holdId = randomUUID();
    await db.insert(issueTreeHolds).values({ id: holdId, companyId: f.companyId, rootIssueId: f.issueId, mode: "pause", status: "active" });
    await db.insert(issueTreeHoldMembers).values({ companyId: f.companyId, holdId, issueId: f.issueId, depth: 0, issueTitle: "Deploy", issueStatus: "blocked" });
    for (let attempt = 0; attempt < 2; attempt++) {
      await makeDue();
      await heartbeatService(db).resumeExecutionWaitComments();
    }
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toHaveLength(1);
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).not.toBeNull();
    const [paused] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, waiting.id));
    expect(paused.payload?.executionWait).toMatchObject({ reason: "issue_tree_hold_active" });
    await db.update(issueTreeHolds).set({ status: "released" }).where(eq(issueTreeHolds.id, holdId));
    await db.update(agents).set({ runtimeConfig: { heartbeat: { maxConcurrentRuns: 1, maxDailyRuns: 0 } } }).where(eq(agents.id, f.agentId));
    for (let attempt = 0; attempt < 2; attempt++) {
      await makeDue();
      await heartbeatService(db).resumeExecutionWaitComments();
    }
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toHaveLength(1);
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).not.toBeNull();
    await db.update(agents).set({ runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } }).where(eq(agents.id, f.agentId));
    await makeDue();
    await Promise.all([heartbeatService(db).resumeExecutionWaitComments(), heartbeatService(db).resumeExecutionWaitComments()]);
    const runs = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.status, "queued")));
    expect(runs).toHaveLength(1);
    expect(runs[0].contextSnapshot).toMatchObject({ forceFreshSession: true, previousRunId: f.sourceRunId,
      explicitUserContinuation: { commentId: f.commentId } });
    const [adopted] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, waiting.id));
    expect(adopted).toMatchObject({ status: "coalesced", runId: runs[0].id });
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
  });


  it.each(["issue_commented", "retry_failed_run"])("does not bypass an unsafe restore hold through %s", async reason => {
    const f = await seed();
    await db.update(agents).set({ adapterType: "grok_local" }).where(eq(agents.id, f.agentId));
    await db.update(heartbeatRuns).set({ runtimeMode: "legacy", processPid: null,
      errorCode: "workspace_restore_failed", resultJson: { workspaceRestoreFailure: "restore_unsafe_archive", conversationContinuation: "continue_conversation_v1" },
    }).where(eq(heartbeatRuns.id, f.sourceRunId));
    await db.delete(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.sourceRunId));
    await db.update(issueRecoveryActions).set({ cause: "legacy_execution_requires_reconciliation" }).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    const blocked = vi.fn();
    expect(await db.transaction(tx => admitExplicitNativeContinuation({ ...f, reason,
      commentId: reason === "issue_commented" ? f.commentId : null,
      failedRunId: reason === "retry_failed_run" ? f.sourceRunId : null,
      onBlocked: blocked, db: tx as unknown as typeof db,
    }))).toBeNull();
    expect(blocked).toHaveBeenCalledWith("workspace_repair_required", expect.any(String));
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({ runId: f.sourceRunId });
  });

  it.each(["issue_commented", "retry_failed_run"])("continues a legacy Daytona run lost before adapter.invoke: %s", async reason => {
    const f = await seed();
    await db.update(agents).set({ adapterType: "claude_local" }).where(eq(agents.id, f.agentId));
    await db.update(heartbeatRuns).set({ runtimeMode: "legacy", processPid: null,
      errorCode: "process_lost" }).where(eq(heartbeatRuns.id, f.sourceRunId));
    await db.delete(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.sourceRunId));
    await db.update(issueRecoveryActions).set({ cause: "legacy_execution_requires_reconciliation" })
      .where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    const [environment] = await db.insert(environments).values({ name: `Daytona startup ${f.sourceRunId}`, driver: "sandbox" }).returning();
    const identity = { id: randomUUID(), companyId: f.companyId, heartbeatRunId: f.sourceRunId,
      provider: "daytona", providerLeaseId: "startup-sandbox" };
    await db.insert(environmentLeases).values({ ...identity, environmentId: environment.id,
      status: "released", leasePolicy: "ephemeral", releasedAt: new Date(), cleanupStatus: "success",
      metadata: { remoteExecutionTermination: remoteTerminationReceipt(identity,
        { providerLeaseId: identity.providerLeaseId, state: "destroyed" }) } });
    const result = await db.transaction(tx => admitExplicitNativeContinuation({ ...f, reason,
      commentId: reason === "issue_commented" ? f.commentId : null,
      failedRunId: reason === "retry_failed_run" ? f.sourceRunId : null,
      db: tx as unknown as typeof db }));
    expect(result).toMatchObject({ previousRunId: f.sourceRunId });
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
    const [source] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.sourceRunId));
    expect(source.resultJson).toBeNull();
  });

  it.each(["claim", "invocation"])("does not convert a known process run after switching the agent to Claude: %s", async evidence => {
    const f = await seed();
    await db.update(agents).set({ adapterType: "claude_local" }).where(eq(agents.id, f.agentId));
    await db.update(heartbeatRuns).set({ runtimeMode: "legacy", errorCode: "process_lost",
      runnerProfileJson: evidence === "claim" ? { adapterDispatch: { adapterType: "process" } } : null,
    }).where(eq(heartbeatRuns.id, f.sourceRunId));
    if (evidence === "invocation") await db.insert(heartbeatRunEvents).values({ companyId: f.companyId,
      runId: f.sourceRunId, agentId: f.agentId, seq: 1, eventType: "adapter.invoke", payload: { adapterType: "process" } });
    await db.update(issueRecoveryActions).set({ cause: "legacy_execution_requires_reconciliation" })
      .where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    expect(await admit(f)).toBeNull();
    expect(await admitExplicitNativeContinuation({ ...f, db, reason: "retry_failed_run",
      commentId: null, failedRunId: f.sourceRunId })).toBeNull();
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).not.toBeNull();
  });

  it("keeps failed remote cleanup blocked even after the lease release timestamp is recorded", async () => {
    const f = await seed();
    await db.update(heartbeatRuns).set({ runtimeMode: "legacy", processPid: null,
      resultJson: { conversationContinuation: "continue_conversation_v1" } }).where(eq(heartbeatRuns.id, f.sourceRunId));
    const [environment] = await db.insert(environments).values({ name: `Cleanup ${f.sourceRunId}`, driver: "sandbox" }).returning();
    await db.insert(environmentLeases).values({ companyId: f.companyId, heartbeatRunId: f.sourceRunId,
      environmentId: environment.id, provider: "daytona", providerLeaseId: "still-running",
      status: "pending_cleanup", releasedAt: new Date(), cleanupStatus: "failed", leasePolicy: "ephemeral" });
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({ cause: "execution_owner_active" });
    await db.delete(environmentLeases).where(eq(environmentLeases.heartbeatRunId, f.sourceRunId));
  });

  it("retries exhausted cleanup only for the selected failed run and adopts concurrent Retry clicks", async () => {
    const f = await seed(), other = await seed();
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" });
    const identities = [f, other].map(fixture => ({ id: randomUUID(), companyId: fixture.companyId,
      heartbeatRunId: fixture.sourceRunId, provider: "daytona", providerLeaseId: fixture.sourceRunId }));
    for (const identity of identities) await db.insert(environmentLeases).values({ ...identity,
      status: "pending_cleanup", leasePolicy: "ephemeral", releasedAt: new Date(), cleanupStatus: "failed",
      metadata: { pendingCleanupRetryAttempts: 5, pendingCleanupRetryCapWarned: true } });
    const destroyed: string[] = [];
    let readyCount = 0;
    let bothReady!: () => void;
    const ready = new Promise<void>(resolve => { bothReady = resolve; });
    const heartbeat = heartbeatService(db, { environmentRuntime: {
      isPendingCleanupWorkerReady: async () => { if (++readyCount === 2) bothReady(); await ready; return true; },
      retryPendingSandboxTeardown: async ({ lease }: { lease: { id: string; providerLeaseId: string } }) => {
        destroyed.push(lease.id);
        return { providerLeaseId: lease.providerLeaseId, state: "destroyed" };
      },
    } as unknown as HeartbeatEnvironmentRuntime });
    const request = { source: "on_demand" as const, triggerDetail: "manual" as const,
      reason: "retry_failed_run", failedRunId: f.sourceRunId,
      requestedByActorType: "user" as const, requestedByActorId: "board", payload: { issueId: f.issueId } };
    try {
      const [first, second] = await Promise.all([heartbeat.wakeup(f.agentId, request), heartbeat.wakeup(f.agentId, request)]);
      // A losing cleanup claim can still see the hold until the winner finishes;
      // a subsequent click adopts the already admitted successor.
      const successor = first ?? second;
      expect(successor?.id).toBeTruthy();
      expect((await heartbeat.wakeup(f.agentId, request))?.id).toBe(successor?.id);
      expect(destroyed).toEqual([identities[0].id]);
      const [untouched] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, identities[1].id));
      expect(untouched).toMatchObject({ status: "pending_cleanup", metadata: { pendingCleanupRetryAttempts: 5 } });
      expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
    } finally {
      for (const identity of identities) await db.delete(environmentLeases).where(eq(environmentLeases.id, identity.id));
    }
  });

  it("allows a later user cleanup attempt after transient failure without resetting automatic retries", async () => {
    const f = await seed();
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" });
    const identity = { id: randomUUID(), companyId: f.companyId, heartbeatRunId: f.sourceRunId,
      provider: "daytona", providerLeaseId: f.sourceRunId };
    await db.insert(environmentLeases).values({ ...identity, status: "pending_cleanup", leasePolicy: "ephemeral",
      releasedAt: new Date(), cleanupStatus: "failed", metadata: { pendingCleanupRetryAttempts: 5 } });
    let attempts = 0;
    const heartbeat = heartbeatService(db, { environmentRuntime: {
      retryPendingSandboxTeardown: async () => {
        if (++attempts < 3) throw new Error("provider temporarily unavailable");
        return { providerLeaseId: identity.providerLeaseId, state: "destroyed" };
      },
    } as unknown as HeartbeatEnvironmentRuntime });
    const request = { source: "on_demand" as const, triggerDetail: "manual" as const,
      reason: "retry_failed_run", failedRunId: f.sourceRunId, requestedByActorType: "user" as const,
      requestedByActorId: "board", payload: { issueId: f.issueId } };
    try {
      expect(await heartbeat.wakeup(f.agentId, request)).toBeNull();
      expect(attempts).toBe(1);
      expect(await heartbeat.wakeup(f.agentId, request)).toBeNull();
      expect(attempts).toBe(2);
      expect(await getExecutionBlocker(db, f.companyId, f.issueId)).not.toBeNull();
      await heartbeat.sweepPendingCleanupLeases();
      expect(attempts).toBe(2);
      const successor = await heartbeat.wakeup(f.agentId, request);
      expect(attempts).toBe(3);
      expect(successor?.retryOfRunId).toBe(f.sourceRunId);
      expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
      expect((await heartbeat.wakeup(f.agentId, request))?.id).toBe(successor?.id);
      expect(attempts).toBe(3);
    } finally {
      await db.delete(environmentLeases).where(eq(environmentLeases.id, identity.id));
    }
  });

  it("queues one exact Retry with fresh history and adopts repeated clicks", async () => {
    const f = await seed();
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" });
    const service = heartbeatService(db);
    const request = { source: "on_demand" as const, triggerDetail: "manual" as const,
      reason: "retry_failed_run", failedRunId: f.sourceRunId,
      requestedByActorType: "user" as const, requestedByActorId: "board", payload: { issueId: f.issueId } };
    const [first, second] = await Promise.all([service.wakeup(f.agentId, request), service.wakeup(f.agentId, request)]);
    expect(first?.id).toBeTruthy();
    expect(second?.id).toBe(first?.id);
    expect(first).toMatchObject({ retryOfRunId: f.sourceRunId,
      contextSnapshot: { previousRunId: f.sourceRunId, forceFreshSession: true } });
    const envelope = await buildExecutionContinuation({ db, companyId: f.companyId, issueId: f.issueId,
      agentId: f.agentId, runId: first!.id, context: first!.contextSnapshot!, summary: null, exposeLowTrustRaw: false });
    expect(envelope.interruptedRunId).toBe(f.sourceRunId);
    await expect(buildExecutionContinuation({ db, companyId: f.companyId, issueId: f.issueId,
      agentId: f.agentId, runId: randomUUID(), context: first!.contextSnapshot!, summary: null, exposeLowTrustRaw: false }))
      .rejects.toThrow("continuation_user_authorization_missing");
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
  });

  it.each([true, false])("acknowledges a legacy remote Stop only after confirmed lease cleanup: %s", async confirmed => {
    const f = await seed();
    await db.update(agents).set({ adapterType: "claude_local" }).where(eq(agents.id, f.agentId));
    await db.update(heartbeatRuns).set({ runtimeMode: "legacy", status: "cancelled", processPid: null,
      resultJson: { executionCancellation: { state: "requested" } },
    }).where(eq(heartbeatRuns.id, f.sourceRunId));
    await db.insert(heartbeatRunEvents).values({ companyId: f.companyId, runId: f.sourceRunId,
      agentId: f.agentId, seq: 1, eventType: "adapter.invoke", payload: { adapterType: "claude_local" } });
    await db.update(issueRecoveryActions).set({ cause: "legacy_execution_requires_reconciliation" })
      .where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    const [environment] = await db.insert(environments).values({ name: `Remote ${f.sourceRunId}`, driver: "sandbox" }).returning();
    const identity = { id: randomUUID(), companyId: f.companyId, heartbeatRunId: f.sourceRunId,
      provider: "daytona", providerLeaseId: "sandbox-legacy" };
    await db.insert(environmentLeases).values({ ...identity, environmentId: environment.id,
      status: "expired", leasePolicy: "ephemeral", releasedAt: new Date(), cleanupStatus: "success",
      metadata: confirmed ? { remoteExecutionTermination: remoteTerminationReceipt(identity,
        { providerLeaseId: identity.providerLeaseId, state: "destroyed" }) } : {},
    });
    await heartbeatService(db).releaseEnvironmentLeasesForRun({ runId: f.sourceRunId,
      companyId: f.companyId, agentId: f.agentId, status: "cancelled" });
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.sourceRunId));
    expect(run.resultJson?.executionCancellation).toMatchObject({ state: confirmed ? "acknowledged" : "requested" });
    if (confirmed) expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
    else expect(await getExecutionBlocker(db, f.companyId, f.issueId)).not.toBeNull();
  });

  it.each(["stopped", "destroyed", "missing", "wrong_lease", "cleanup_failed", "active"])(
    "admits a remote native predecessor only with confirmed termination: %s", async kind => {
      const f = await seed();
      // This PID exists on the control-plane host. It must never be used to
      // infer liveness of the identically numbered remote process.
      await db.update(heartbeatRuns).set({ processPid: process.pid }).where(eq(heartbeatRuns.id, f.sourceRunId));
      const [environment] = await db.insert(environments).values({ name: `Remote ${f.sourceRunId}`, driver: "sandbox" }).returning();
      const identity = { id: randomUUID(), companyId: f.companyId, heartbeatRunId: f.sourceRunId,
        provider: "daytona", providerLeaseId: "sandbox-1" };
      const proof = remoteTerminationReceipt(identity, { providerLeaseId: "sandbox-1",
        state: kind === "destroyed" ? "destroyed" : "stopped" });
      await db.insert(environmentLeases).values({ ...identity, environmentId: environment.id,
        issueId: f.issueId, status: kind === "active" ? "active" : "released", leasePolicy: "ephemeral",
        releasedAt: kind === "active" ? null : new Date(), cleanupStatus: kind === "cleanup_failed" ? "failed" : "success",
        metadata: kind === "missing" ? {} : { remoteExecutionTermination:
          kind === "wrong_lease" ? { ...proof, providerLeaseId: "other-sandbox" } : proof },
      });
      const result = await admit(f);
      if (["stopped", "destroyed"].includes(kind)) expect(result).toMatchObject({ previousRunId: f.sourceRunId });
      else expect(result).toBeNull();
    },
  );

  it.each([
    { runtime: "native", retry: false }, { runtime: "native", retry: true },
    { runtime: "legacy", retry: false }, { runtime: "legacy", retry: true },
    { runtime: "legacy_startup", retry: false }, { runtime: "legacy_startup", retry: true },
  ])("resumes a user message after confirmed cleanup: %j", async ({ runtime, retry }) => {
    const f = await seed();
    if (runtime.startsWith("legacy")) {
      await db.update(agents).set({ adapterType: "claude_local" }).where(eq(agents.id, f.agentId));
      await db.update(heartbeatRuns).set({ runtimeMode: "legacy", status: "cancelled", processPid: null,
        resultJson: { executionCancellation: { state: "requested" } } }).where(eq(heartbeatRuns.id, f.sourceRunId));
      if (runtime === "legacy_startup") {
        await db.update(heartbeatRuns).set({ status: "failed", resultJson: null, errorCode: "process_lost" })
          .where(eq(heartbeatRuns.id, f.sourceRunId));
      } else await db.insert(heartbeatRunEvents).values({ companyId: f.companyId, runId: f.sourceRunId,
        agentId: f.agentId, seq: 1, eventType: "adapter.invoke", payload: { adapterType: "claude_local" } });
      await db.update(issueRecoveryActions).set({ cause: "legacy_execution_requires_reconciliation" })
        .where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    }
    // Keep the successor queued so this test never starts an actual provider.
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" });
    const [environment] = await db.insert(environments).values({ name: `pending-${f.sourceRunId}`, driver: "sandbox" }).returning();
    const identity = { id: randomUUID(), companyId: f.companyId, heartbeatRunId: f.sourceRunId,
      provider: "daytona", providerLeaseId: "pending-sandbox" };
    await db.insert(environmentLeases).values({ ...identity, environmentId: environment.id, status: "active", leasePolicy: "ephemeral" });
    const heartbeat = heartbeatService(db, retry ? { environmentRuntime: {
      retryPendingSandboxTeardown: async () => ({ providerLeaseId: identity.providerLeaseId, state: "destroyed" }),
    } as unknown as HeartbeatEnvironmentRuntime } : {});
    await heartbeat.wakeup(f.agentId, { source: "automation", triggerDetail: "system", reason: "issue_commented",
      requestedByActorType: "user", requestedByActorId: "board", payload: { issueId: f.issueId, commentId: f.commentId },
      contextSnapshot: { issueId: f.issueId, wakeCommentId: f.commentId } });
    const [source] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.sourceRunId));
    await heartbeat.resumeRemoteStopComments(source);
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).not.toBeNull();
    if (retry) {
      await db.update(environmentLeases).set({ status: "pending_cleanup", cleanupStatus: "failed" })
        .where(eq(environmentLeases.id, identity.id));
      expect(await heartbeat.sweepPendingCleanupLeases()).toMatchObject({ destroyed: 1 });
      const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, identity.id));
      expect(lease.metadata?.remoteExecutionTermination).toMatchObject({ runId: f.sourceRunId, state: "destroyed" });
    } else {
      await db.update(environmentLeases).set({ status: "released", releasedAt: new Date(), cleanupStatus: "success",
        metadata: { remoteExecutionTermination: remoteTerminationReceipt(identity,
          { providerLeaseId: identity.providerLeaseId, state: "stopped" }) } }).where(eq(environmentLeases.id, identity.id));
      await heartbeat.releaseEnvironmentLeasesForRun({ runId: source.id, companyId: source.companyId,
        agentId: source.agentId, status: source.status });
    }
    await heartbeat.resumeRemoteStopComments(source);
    await heartbeat.resumeRemoteStopComments(source);
    const runs = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.status, "queued")));
    expect(runs).toHaveLength(1);
    if (runtime !== "legacy") expect(runs[0].contextSnapshot).toMatchObject({ forceFreshSession: true, previousRunId: f.sourceRunId,
      explicitUserContinuation: { commentId: f.commentId } });
    else expect(runs[0].contextSnapshot).toMatchObject({ wakeCommentId: f.commentId });
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
  });

  it("queues the actual user wake with a fresh session and retained source context", async () => {
    const f = await seed();
    // Occupy this agent's only slot so this admission test never starts a provider.
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" });
    const wake = await heartbeatService(db).wakeup(f.agentId, {
      source: "automation", triggerDetail: "system", reason: "issue_commented",
      requestedByActorType: "user", requestedByActorId: "board",
      payload: { issueId: f.issueId, commentId: f.commentId },
      contextSnapshot: { issueId: f.issueId, wakeCommentId: f.commentId },
    });
    expect(wake).toMatchObject({ status: "queued", retryOfRunId: null,
      contextSnapshot: { forceFreshSession: true, previousRunId: f.sourceRunId,
        explicitUserContinuation: { previousRunId: f.sourceRunId, commentId: f.commentId } } });
    const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    expect(action.evidence.explicitUserContinuation).toMatchObject({ runId: wake!.id });
    const envelope = await buildExecutionContinuation({ db, companyId: f.companyId, issueId: f.issueId,
      agentId: f.agentId, context: wake!.contextSnapshot!, summary: "Deployment completed.", exposeLowTrustRaw: false });
    expect(envelope.interruptedRunId).toBe(f.sourceRunId);
    expect(envelope.objective).toBe("What happened?");
    expect(envelope.completedWork).toBe("Deployment completed.");
  });

  it.each(["pause", "dependency", "state"])("keeps the existing %s gate on the actual user wake", async gate => {
    const f = await seed();
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" });
    if (gate === "pause") {
      const holdId = randomUUID();
      await db.insert(issueTreeHolds).values({ id: holdId, companyId: f.companyId, rootIssueId: f.issueId, mode: "pause", status: "active" });
      await db.insert(issueTreeHoldMembers).values({ companyId: f.companyId, holdId, issueId: f.issueId, depth: 0, issueTitle: "Deploy", issueStatus: "blocked" });
    } else if (gate === "dependency") {
      const blockerId = randomUUID();
      await db.insert(issues).values({ id: blockerId, companyId: f.companyId, title: "Required approval", status: "todo" });
      await db.insert(issueRelations).values({ companyId: f.companyId, issueId: blockerId, relatedIssueId: f.issueId, type: "blocks" });
    }
    const wake = await heartbeatService(db).wakeup(f.agentId, {
      source: "automation", triggerDetail: "system", reason: "issue_commented", requestedByActorType: "user", requestedByActorId: "board",
      ...(gate === "state" ? { issueStateGuard: { statuses: ["todo"], assigneeAgentId: f.agentId } } : {}),
      payload: { issueId: f.issueId, commentId: f.commentId }, contextSnapshot: { issueId: f.issueId, wakeCommentId: f.commentId },
    });
    const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    if (gate === "pause" || gate === "state") {
      expect(wake).toBeNull();
      expect(action.evidence.explicitUserContinuation).toBeUndefined();
    } else {
      expect(wake).toMatchObject({ contextSnapshot: { dependencyBlockedInteraction: true, unresolvedBlockerCount: 1 } });
      expect(await db.select().from(issueRelations).where(eq(issueRelations.companyId, f.companyId))).toHaveLength(1);
    }
  });

  it("preflights eligibility without retiring the hold or creating a successor", async () => {
    const f = await seed();
    expect(await admit(f, true)).toMatchObject({ previousRunId: f.sourceRunId });
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).not.toBeNull();
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.successorRunId))).toHaveLength(0);
    const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    expect(action.evidence.explicitUserContinuation).toBeUndefined();
  });
  it("retains the message receipt without a phantom run when ownership is still live", async () => {
    const f = await seed();
    await db.update(heartbeatRuns).set({ processPid: process.pid }).where(eq(heartbeatRuns.id, f.sourceRunId));
    const wake = await heartbeatService(db).wakeup(f.agentId, {
      source: "automation", triggerDetail: "system", reason: "issue_commented",
      requestedByActorType: "user", requestedByActorId: "board",
      payload: { issueId: f.issueId, commentId: f.commentId },
      contextSnapshot: { issueId: f.issueId, wakeCommentId: f.commentId },
    });
    expect(wake).toBeNull();
    const [receipt] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId));
    expect(receipt).toMatchObject({ status: "deferred_issue_execution", requestedByActorId: "board", runId: null });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(1);
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).not.toBeNull();
  });
  it("lets a new human message continue after exhausted recovery without certifying old actions", async () => {
    const f = await seed();
    expect(await admit(f)).toEqual({ previousRunId: f.sourceRunId, commentId: f.commentId });
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
    const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    expect(action.evidence).toMatchObject({ automaticRecovery: { actionOutcome: "unknown" }, explicitUserContinuation: { runId: f.successorRunId, commentId: f.commentId } });
    const [source] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.sourceRunId));
    expect(source.status).toBe("failed");
    const [coordinator] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.sourceRunId));
    expect(coordinator.attempt).toBe(3);
    expect(coordinator.failureDetail?.replacementDenied).toBe("explicit_user_continuation");
  });

  it.each(["ready", "live_process", "pause", "delivered", "mixed_authors", "last_delivered", "operator_stop"])(
    "automatically delivers an unconsumed native message sent before the failed run stopped, respecting %s", async gate => {
    const f = await seed();
    await db.update(issueComments).set({ createdAt: new Date("2026-09-11T09:59:00Z") }).where(eq(issueComments.id, f.commentId));
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" });
    let queuedIds = [f.commentId];
    let expectedIds = queuedIds;
    if (["mixed_authors", "last_delivered"].includes(gate)) {
      const secondId = randomUUID();
      await db.insert(issueComments).values({ id: secondId, companyId: f.companyId, issueId: f.issueId,
        authorType: "user", authorUserId: "second-author", body: "Also preserve the existing work.",
        createdAt: new Date("2026-09-11T09:59:01Z") });
      queuedIds = [f.commentId, secondId];
      expectedIds = gate === "last_delivered" ? [f.commentId] : queuedIds;
      if (gate === "last_delivered") await db.update(heartbeatRuns).set({
        contextSnapshot: { issueId: f.issueId, wakeCommentIds: [secondId] },
      }).where(eq(heartbeatRuns.id, f.sourceRunId));
    }
    if (gate === "live_process") await db.update(heartbeatRuns).set({ processPid: process.pid }).where(eq(heartbeatRuns.id, f.sourceRunId));
    if (gate === "operator_stop") await db.update(heartbeatRuns).set({ status: "cancelled", errorCode: "operator_interrupted" }).where(eq(heartbeatRuns.id, f.sourceRunId));
    if (gate === "delivered") await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.issueId,
      wakeCommentIds: queuedIds } }).where(eq(heartbeatRuns.id, f.sourceRunId));
    if (gate === "pause") {
      const holdId = randomUUID();
      await db.insert(issueTreeHolds).values({ id: holdId, companyId: f.companyId, rootIssueId: f.issueId, mode: "pause", status: "active" });
      await db.insert(issueTreeHoldMembers).values({ companyId: f.companyId, holdId, issueId: f.issueId, depth: 0, issueTitle: "Deploy", issueStatus: "blocked" });
    }
    const queueId = randomUUID();
    await db.insert(agentWakeupRequests).values({ id: queueId, companyId: f.companyId, agentId: f.agentId,
      source: "automation", status: "deferred_issue_execution", reason: "issue_commented",
      requestedByActorType: "user", requestedByActorId: "board", updatedAt: new Date(0),
      payload: { issueId: f.issueId, commentId: queuedIds.at(-1), executionWait: { reason: "execution_recovery" },
        _paperclipWakeContext: { issueId: f.issueId, wakeReason: "issue_commented", wakeCommentIds: queuedIds, wakeCommentId: queuedIds.at(-1) } },
    });
    const service = heartbeatService(db);
    await service.resumeExecutionWaitComments();
    await service.resumeExecutionWaitComments();
    const [receipt] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, queueId));
    if (!["ready", "mixed_authors", "last_delivered"].includes(gate)) {
      expect(receipt.status).toBe("deferred_issue_execution");
      expect(await getExecutionBlocker(db, f.companyId, f.issueId)).not.toBeNull();
      expect(await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.status, "queued")))).toHaveLength(0);
      return;
    }
    expect(receipt.status).toBe("coalesced");
    const [successor] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, receipt.runId!));
    expect(successor.contextSnapshot).toMatchObject({ wakeCommentIds: expectedIds,
      explicitUserContinuation: { previousRunId: f.sourceRunId, commentId: expectedIds.at(-1) } });
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
    const [prior] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.sourceRunId));
    expect(prior.status).toBe("failed");
  });

  it.each(["native", "before_selection"])("offers and admits an exact Retry for native preparation cancelled before provider startup: %s", async phase => {
    const f = await seedCancelledStartup();
    if (phase === "before_selection") {
      await db.delete(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.sourceRunId));
      await db.update(heartbeatRuns).set({ runtimeMode: "legacy", runtimeModeResolvedAt: null, nativeIssueId: null,
        runnerProfileJson: { adapterDispatch: { adapterType: "paperclip_runner" } },
        resultJson: { startupCancellation: { beforeNativeSelection: true }, startupPreparationSettledAt: new Date().toISOString() },
      }).where(eq(heartbeatRuns.id, f.sourceRunId));
    }
    const blocker = await getExecutionBlocker(db, f.companyId, f.issueId);
    expect(blocker).toMatchObject({ runId: f.sourceRunId, canRetry: true });
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" });
    const service = heartbeatService(db);
    const successor = await service.wakeup(f.agentId, { source: "on_demand", triggerDetail: "manual", reason: "retry_failed_run",
      failedRunId: f.sourceRunId, requestedByActorType: "user", requestedByActorId: "board", payload: { issueId: f.issueId } });
    expect(successor).toMatchObject({ status: "queued", retryOfRunId: f.sourceRunId });
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
  });
  it.each(["failed", "succeeded_result", "rejected_result", "still_committing", "controller", "successor", "live_process"])(
    "requires a fully committed failed result and verified stop for a new turn (%s)", async scenario => {
      const f = await seed(), contractId = randomUUID(), resultId = randomUUID();
      await db.insert(completionContracts).values({ id: contractId, companyId: f.companyId, issueId: f.issueId,
        revision: 1, schemaVersion: "paperclip.completion-contract.v1", policyVersion: "test",
        risk: "standard", completionAuthority: "server_arbiter", incompleteCriteriaPolicy: "preserve_non_terminal",
        contractJson: {}, canonicalSha256: contractId, createdByActorType: "system", createdByActorId: "test" });
      await db.update(heartbeatRuns).set({ completionContractId: contractId,
        ...(scenario === "live_process" ? { processPid: process.pid } : {}),
      }).where(eq(heartbeatRuns.id, f.sourceRunId));
      await db.insert(nativeRunResults).values({ id: resultId, companyId: f.companyId, issueId: f.issueId,
        runId: f.sourceRunId, completionContractId: contractId, serverFingerprint: resultId,
        schemaStatus: scenario === "rejected_result" ? "rejected" : "accepted", canonicalSha256: resultId,
        resultJson: { terminal: { runTerminalState: scenario === "succeeded_result" ? "succeeded" : "failed" } } });
      await db.update(nativeRunFinalizations).set({ resultId,
        phase: scenario === "still_committing" ? "result_accepted" : "committed",
        leaseOwner: scenario === "controller" ? "active-controller" : null,
        failureDetail: scenario === "successor" ? { successorRunId: randomUUID() } : null,
      }).where(eq(nativeRunFinalizations.runId, f.sourceRunId));
      const result = await admit(f);
      if (scenario === "failed") {
        expect(result).toEqual({ previousRunId: f.sourceRunId, commentId: f.commentId });
        expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
        const [saved] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.sourceRunId));
        expect(saved).toMatchObject({ phase: "committed", resultId });
      } else {
        expect(result).toBeNull();
        expect(await getExecutionBlocker(db, f.companyId, f.issueId)).not.toBeNull();
      }
    });
  async function seedResultBeforeTerminalFailure(f: Fixture) {
    const contractId = randomUUID(), resultId = randomUUID();
    await db.insert(completionContracts).values({ id: contractId, companyId: f.companyId, issueId: f.issueId,
      revision: 1, schemaVersion: "paperclip.completion-contract.v1", policyVersion: "test",
      risk: "standard", completionAuthority: "server_arbiter", incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: {}, canonicalSha256: contractId, createdByActorType: "system", createdByActorId: "test" });
    await db.update(heartbeatRuns).set({ completionContractId: contractId, errorCode: "provider_transport_failed" })
      .where(eq(heartbeatRuns.id, f.sourceRunId));
    // Dickens returned a result before checkpoint/suspension failed. Accepting
    // that result did not commit its disposition or make the failed run live.
    await db.insert(nativeRunResults).values({ id: resultId, companyId: f.companyId, issueId: f.issueId,
      runId: f.sourceRunId, completionContractId: contractId, serverFingerprint: resultId,
      schemaStatus: "accepted", canonicalSha256: resultId,
      resultJson: { terminal: { runTerminalState: "succeeded", reportedWorkDisposition: "blocked" } } });
    await db.update(nativeRunFinalizations).set({ resultId, failureCode: "native_session_retry_exhausted" })
      .where(eq(nativeRunFinalizations.runId, f.sourceRunId));
    await db.update(issueRecoveryActions).set({ status: "active", cause: "native_session_retry_exhausted",
      evidence: { runId: f.sourceRunId, coordinatorAttempt: 3, sourceFailureCode: "provider_transport_failed" },
    }).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    return resultId;
  }
  it.each(["stopped", "controller", "successor", "still_committing", "live_process", "identity_missing"])(
    "continues after terminal failure with a retained result only when execution stopped (%s)", async scenario => {
      const f = await seed(), resultId = await seedResultBeforeTerminalFailure(f);
      await db.update(nativeRunFinalizations).set({
        phase: scenario === "still_committing" ? "result_accepted" : "terminal_failure",
        leaseOwner: scenario === "controller" ? "active-controller" : null,
        failureDetail: scenario === "successor" ? { successorRunId: randomUUID() } : null,
      }).where(eq(nativeRunFinalizations.runId, f.sourceRunId));
      if (scenario === "live_process" || scenario === "identity_missing") {
        await db.update(heartbeatRuns).set({ processPid: scenario === "live_process" ? process.pid : null })
          .where(eq(heartbeatRuns.id, f.sourceRunId));
      }
      const result = await admit(f);
      expect(result).toEqual(scenario === "stopped" ? { previousRunId: f.sourceRunId, commentId: f.commentId } : null);
      expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toEqual(scenario === "stopped" ? null : expect.anything());
      const [coordinator] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.sourceRunId));
      expect(coordinator).toMatchObject({ resultId, attempt: 3,
        phase: scenario === "still_committing" ? "result_accepted" : "terminal_failure" });
      const [source] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.sourceRunId));
      expect(source).toMatchObject({ status: "failed", errorCode: "provider_transport_failed" });
      const [savedResult] = await db.select().from(nativeRunResults).where(eq(nativeRunResults.id, resultId));
      expect(savedResult.resultJson).toEqual({ terminal: { runTerminalState: "succeeded", reportedWorkDisposition: "blocked" } });
    });
  it.each(["task", "chat", "chat_with_next_message"])("delivers a queued %s message exactly once after a retained-result failure and delayed remote stop", async kind => {
    const f = await seed(), resultId = await seedResultBeforeTerminalFailure(f);
    const settings = instanceSettingsService(db);
    const experimental = await settings.getExperimental();
    await settings.updateExperimental({ enableAgentChat: true });
    try {
      if (kind !== "task") await db.update(issues).set({ conversationAgentId: f.agentId,
        conversationUserId: "board", conversationState: "active",
      }).where(eq(issues.id, f.issueId));
      // Occupy the agent slot so admission is real without launching a provider.
      await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" });
      const lease = { id: randomUUID(), companyId: f.companyId, heartbeatRunId: f.sourceRunId,
        provider: "daytona", providerLeaseId: "dickens-stopped-sandbox" };
      await db.insert(environmentLeases).values({ ...lease, status: "active", leasePolicy: "ephemeral" });
      const heartbeat = heartbeatService(db);
      const wake = await heartbeat.wakeup(f.agentId, {
        source: "on_demand", triggerDetail: "manual", reason: "issue_commented",
        requestedByActorType: "user", requestedByActorId: "board",
        payload: { issueId: f.issueId, commentId: f.commentId },
        contextSnapshot: { source: "issue.comment", issueId: f.issueId, wakeCommentId: f.commentId },
      });
      expect(wake).toBeNull();
      const [waiting] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId));
      expect(waiting).toMatchObject({ status: "deferred_issue_execution", runId: null,
        payload: { executionWait: { reason: "remote_cleanup" } } });
      let nextCommentId: string | null = null;
      let nextWakeId: string | null = null;
      if (kind === "chat_with_next_message") {
        nextCommentId = randomUUID();
        nextWakeId = randomUUID();
        await db.insert(issueComments).values({ id: nextCommentId, companyId: f.companyId, issueId: f.issueId,
          authorType: "user", authorUserId: "board", body: "A separate follow-up." });
        await db.insert(agentWakeupRequests).values({ id: nextWakeId, companyId: f.companyId, agentId: f.agentId,
          source: "on_demand", triggerDetail: "manual", reason: "issue_commented", status: "deferred_issue_execution",
          requestedByActorType: "user", requestedByActorId: "board", payload: {
            issueId: f.issueId, commentId: nextCommentId,
            _paperclipWakeContext: { source: "issue.comment", issueId: f.issueId, wakeCommentId: nextCommentId, wakeReason: "issue_commented" },
          },
        });
      }
      const [source] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.sourceRunId));
      await heartbeat.resumeRemoteStopComments(source);
      expect(await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.status, "queued")))).toHaveLength(0);
      await db.update(environmentLeases).set({ status: "released", releasedAt: new Date(), cleanupStatus: "success",
        metadata: { remoteExecutionTermination: remoteTerminationReceipt(lease, { providerLeaseId: lease.providerLeaseId, state: "stopped" }) },
      }).where(eq(environmentLeases.id, lease.id));
      // Cleanup and periodic recovery can race to dispatch the same receipt.
      await Promise.all([heartbeat.resumeRemoteStopComments(source), heartbeat.resumeRemoteStopComments(source)]);
      const successors = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.status, "queued")));
      expect(successors).toHaveLength(1);
      expect(successors[0].contextSnapshot).toMatchObject({ forceFreshSession: true, previousRunId: f.sourceRunId, wakeCommentId: f.commentId });
      if (nextWakeId) {
        expect(successors[0].contextSnapshot?.wakeCommentIds).not.toContain(nextCommentId);
        const [nextWake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, nextWakeId));
        expect(nextWake.status).toBe("deferred_issue_execution");
      }
      // Complete the admitted turn and run the same transactional queue drain
      // used by finalization. A stale receipt must not create another turn.
      await db.update(heartbeatRuns).set({ status: "succeeded", startedAt: new Date(), finishedAt: new Date() })
        .where(eq(heartbeatRuns.id, successors[0].id));
      await db.update(issues).set({ executionRunId: successors[0].id, status: "in_progress" })
        .where(eq(issues.id, f.issueId));
      const release = createReleaseIssueExecution({
        issueLock: createPostgresWakeQueueAdapter(db, {
          resolveResponsibleUserId: async () => "board",
          getRoutineEnv: async () => ({ routineId: null, env: null, responsibleUserId: null }),
          resolveSessionBeforeForWakeup: async () => null,
        }),
        recovery: { escalateStrandedAssignedIssue: async () => {}, escalateStrandedRecoveryIssueInPlace: async () => {} },
      });
      const drained = await release({ companyId: f.companyId, runId: successors[0].id, now: new Date(), suppressImmediateRecovery: true });
      expect(drained.outcome.kind).toBe(nextWakeId ? "promoted" : "released");
      await heartbeat.resumeRemoteStopComments(source);
      await release({ companyId: f.companyId, runId: successors[0].id, now: new Date(), suppressImmediateRecovery: true });
      const afterDrain = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.status, "queued")));
      expect(afterDrain).toHaveLength(nextWakeId ? 1 : 0);
      if (nextWakeId) {
        expect(afterDrain[0]).toMatchObject({ wakeupRequestId: nextWakeId, contextSnapshot: { wakeCommentId: nextCommentId } });
        expect(afterDrain[0].contextSnapshot?.wakeCommentIds ?? []).not.toContain(f.commentId);
      }
      const [delivered] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, waiting.id));
      expect(delivered).toMatchObject({ status: "coalesced", runId: successors[0].id });
      const [coordinator] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.sourceRunId));
      expect(coordinator).toMatchObject({ phase: "terminal_failure", resultId, attempt: 3 });
      expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
    } finally {
      await settings.updateExperimental({ enableAgentChat: experimental.enableAgentChat });
    }
  });
  it("keeps exhausted workspace export on its own repair path after the sandbox stops", async () => {
    const f = await seed(), resultId = await seedResultBeforeTerminalFailure(f);
    await db.delete(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    await db.update(nativeRunFinalizations).set({ phase: "result_accepted", attempt: 1, failureCode: null, failureDetail: null })
      .where(eq(nativeRunFinalizations.runId, f.sourceRunId));
    await db.update(heartbeatRuns).set({ status: "running", nativePhase: "result_accepted", finishedAt: null })
      .where(eq(heartbeatRuns.id, f.sourceRunId));
    const lease = { id: randomUUID(), companyId: f.companyId, heartbeatRunId: f.sourceRunId,
      provider: "daytona", providerLeaseId: "pending-workspace-export" };
    await db.insert(environmentLeases).values({ ...lease, status: "active", leasePolicy: "ephemeral" });
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.sourceRunId));
    await db.update(heartbeatRuns).set({ runnerProfileJson: { ...run.runnerProfileJson,
      nativeWorkspaceSync: { schema: "paperclip.native-workspace-sync/v1", state: "prepared",
        descriptorSha256: "a".repeat(64), baselineSha256: "b".repeat(64), finalHostSha256: null,
        workspaceId: randomUUID(), leaseId: lease.id, providerLeaseId: lease.providerLeaseId,
        remoteCwd: "/work", resourceDisposition: "destroy" },
    } }).where(eq(heartbeatRuns.id, f.sourceRunId));
    for (let attempt = 0; attempt < 3; attempt++) {
      await recordNativeFinalizationFailure({ db, runId: f.sourceRunId,
        error: new Error("native_workspace_sync_out_failed"), failureScope: "workspace", projectRunStatus: true });
    }
    const [retainedLease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, lease.id));
    expect(retainedLease).toMatchObject({ status: "pending_cleanup", metadata: {
      nativeWorkspaceExportResume: { runId: f.sourceRunId, leaseId: lease.id, resultId },
    } });
    await db.update(environmentLeases).set({ status: "released", releasedAt: new Date(), cleanupStatus: "success",
      metadata: { ...retainedLease.metadata,
        remoteExecutionTermination: remoteTerminationReceipt(lease, { providerLeaseId: lease.providerLeaseId, state: "stopped" }) },
    }).where(eq(environmentLeases.id, lease.id));
    const exportState = () => Promise.all([
      db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.sourceRunId)),
      db.select().from(nativeRunResults).where(eq(nativeRunResults.id, resultId)),
      db.select().from(environmentLeases).where(eq(environmentLeases.id, lease.id)),
      db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId)),
    ]);
    const before = await exportState();
    // Export repair is intentionally excluded before conversation stop checks.
    // A new message must leave the accepted result, retention, and repair intact.
    await db.update(issueComments).set({ createdAt: new Date(Date.now() + 1000) }).where(eq(issueComments.id, f.commentId));
    expect(await admit(f)).toBeNull();
    expect(await exportState()).toEqual(before);
    const [coordinator] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.sourceRunId));
    expect(coordinator).toMatchObject({ phase: "terminal_failure", resultId, attempt: 1,
      failureCode: "native_workspace_sync_out_retry_exhausted", failureDetail: { workspaceFinalizeAttempt: 3 } });
    const [action] = await db.select().from(issueRecoveryActions).where(and(
      eq(issueRecoveryActions.sourceIssueId, f.issueId), eq(issueRecoveryActions.cause, "native_workspace_sync_out_retry_exhausted"),
    ));
    expect(action).toMatchObject({ status: "active", cause: "native_workspace_sync_out_retry_exhausted" });
  });
  it.each(["linked", "revoked", "unlinked", "wrong_author"])(
    "admits a fresh Slack message after failure only with current linked-user authority (%s)", async scenario => {
      const f = await seed();
      // Keep execution queued so this tests real admission without launching a provider.
      await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" });
      const authorize = vi.fn(async () => { if (scenario === "revoked") throw new Error("chat_authorization_revoked"); });
      const request = createDurableChatWakeupRequest({ id: randomUUID(), ...f,
        requestedByActorType: scenario === "unlinked" ? "system" : "user",
        requestedByActorId: scenario === "wrong_author" ? "another-user" : "board", requestedAt: new Date(), authorize });
      const wake = () => heartbeatService(db).wakeup(f.agentId, {
        source: "assignment", triggerDetail: "system", reason: "External chat message received",
        requestedByActorType: request.requestedByActorType, requestedByActorId: request.requestedByActorId,
        payload: { issueId: f.issueId, wakeCommentId: f.commentId, mutation: "chat_message_received" },
        contextSnapshot: { issueId: f.issueId, wakeCommentId: f.commentId, source: "chat:slack" },
        durableChatRequest: request,
      });
      if (scenario === "revoked") await expect(wake()).rejects.toThrow("chat_authorization_revoked");
      else await wake();
      expect(authorize).toHaveBeenCalled();
      const successors = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.status, "queued")));
      expect(successors).toHaveLength(scenario === "linked" ? 1 : 0);
      if (scenario === "linked") {
        expect(successors[0].contextSnapshot).toMatchObject({ forceFreshSession: true, previousRunId: f.sourceRunId });
        expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
      } else expect(await getExecutionBlocker(db, f.companyId, f.issueId)).not.toBeNull();
    });
  it.each(["live_process", "missing_process", "lease", "coordinator", "successor", "agent_message", "old_comment", "wrong_author", "run_authored", "reassigned", "automatic", "approval", "question", "malformed_comment", "legacy_owner"])("keeps the hold for %s", async kind => {
    const f = await seed();
    if (kind === "legacy_owner") await db.insert(heartbeatRuns).values({ companyId: f.companyId,
      agentId: f.agentId, status: "failed", runtimeMode: "legacy", processPid: process.pid,
      contextSnapshot: { issueId: f.issueId }, resultJson: { conversationContinuation: "continue_conversation_v1" } });
    if (kind === "live_process") await db.update(heartbeatRuns).set({ processPid: process.pid }).where(eq(heartbeatRuns.id, f.sourceRunId));
    if (kind === "missing_process") await db.update(heartbeatRuns).set({ processPid: null }).where(eq(heartbeatRuns.id, f.sourceRunId));
    if (kind === "coordinator") await db.update(nativeRunFinalizations).set({ leaseOwner: "active-controller" }).where(eq(nativeRunFinalizations.runId, f.sourceRunId));
    if (kind === "successor") await db.update(nativeRunFinalizations).set({ failureDetail: { successorRunId: randomUUID() } }).where(eq(nativeRunFinalizations.runId, f.sourceRunId));
    if (kind === "lease") {
      const [environment] = await db.select().from(environments).where(eq(environments.driver, "local"));
      const environmentId = environment.id;
      await db.insert(environmentLeases).values({ companyId: f.companyId, environmentId, heartbeatRunId: f.sourceRunId, issueId: f.issueId, status: "active", leasePolicy: "ephemeral", provider: "local" });
    }
    if (kind === "question") await db.insert(issueThreadInteractions).values({
      companyId: f.companyId, issueId: f.issueId, kind: "ask_user_questions", status: "pending", payload: { version: 1, questions: [] },
    });
    if (kind === "approval") {
      const approvalId = randomUUID();
      await db.insert(approvals).values({ id: approvalId, companyId: f.companyId, type: "hire_agent", status: "pending", payload: {} });
      await db.insert(issueApprovals).values({ companyId: f.companyId, issueId: f.issueId, approvalId });
    }
    if (kind === "malformed_comment") f.commentId = "not-a-uuid";
    if (kind === "agent_message") f.actorType = "agent";
    if (kind === "automatic") f.reason = "issue_continuation_needed";
    if (kind === "wrong_author") f.actorId = "someone-else";
    if (kind === "run_authored") await db.update(issueComments).set({ createdByRunId: f.sourceRunId }).where(eq(issueComments.id, f.commentId));
    if (kind === "old_comment") await db.update(issueComments).set({ createdAt: new Date("2026-09-11T09:00:00Z") }).where(eq(issueComments.id, f.commentId));
    if (kind === "reassigned") await db.update(issues).set({ assigneeAgentId: null }).where(eq(issues.id, f.issueId));
    expect(await admit(f)).toBeNull();
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).not.toBeNull();
  });
  it.each(["foreign_source", "missing_authorization", "nonterminal_source"])("rejects unverified interruption context: %s", async kind => {
    const f = await seed();
    let previousRunId: string = f.sourceRunId;
    if (kind === "foreign_source") previousRunId = (await seed()).sourceRunId;
    if (kind === "nonterminal_source") {
      await admit(f);
      await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, f.sourceRunId));
    }
    await expect(buildExecutionContinuation({ db, companyId: f.companyId, issueId: f.issueId,
      agentId: f.agentId, context: { previousRunId: f.sourceRunId,
        explicitUserContinuation: { previousRunId, commentId: f.commentId } },
      summary: null, exposeLowTrustRaw: false })).rejects.toThrow("continuation_user_authorization_missing");
  });
  it("keeps one new turn under concurrent delivery of the same message", async () => {
    const f = await seed();
    const results = await Promise.all([admit(f), admit(f)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.status, "queued")))).toHaveLength(1);
  });
  it("retains the source incident through prior rejected message admissions", async () => {
    const f = await seed(), rejectedRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: rejectedRunId, companyId: f.companyId, agentId: f.agentId,
      status: "cancelled", errorCode: "execution_reconciliation_required", contextSnapshot: { issueId: f.issueId },
      finishedAt: new Date("2026-09-11T10:30:00Z") });
    await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.issueId,
      kind: "active_run_watchdog", cause: "legacy_execution_requires_reconciliation", fingerprint: rejectedRunId,
      status: "resolved", outcome: "blocked", nextAction: "Could not start", evidence: { runId: rejectedRunId, automaticRecovery: { replay: "blocked" } } });
    expect(await admit(f)).toMatchObject({ previousRunId: f.sourceRunId });
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
  });
});
