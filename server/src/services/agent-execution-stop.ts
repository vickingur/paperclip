import { readProcessStartedAt } from "./hot-restart.js";
import { historicalAdapterType, isConversationAdapter } from "./conversation-continuation.js";
import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { environmentLeases, heartbeatRunEvents, heartbeatRuns, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { hasNativeLocalProcessStop } from "./native-local-process-stop.js";
import { hasRemoteTerminationReceipt } from "./remote-execution-termination.js";
import { isCancelledNativeStartup } from "./cancelled-native-startup.js";

export interface ExecutionStopBlocker {
  runId: string | null;
  reason: "environment_cleanup" | "finalization_owned" | "controller_running" | "run_active" |
    "controller_lease" | "remote_termination_missing" | "process_running" | "stop_proof_missing" | "finalization_changed";
  leaseId?: string;
}

/** Historical completion is distinct from cancellation acknowledgement. Require
 * explicit provider-stop/action-settlement evidence, the executor's settled
 * boundary, and its persisted adapter exit plus matching
 * completion event. A terminal row or an adapter name alone never suffices.
 * Later dispatch invalidates the event; no run/cancellation evidence is rewritten.
 */
export async function hasHistoricalLegacyCompletion(db: Db, run: typeof heartbeatRuns.$inferSelect) {
  const recovery = run.resultJson?.executionRecovery as Record<string, unknown> | undefined;
  if (recovery?.providerStopped !== true || recovery.actionOutcomes !== "settled") return false;
  if (run.runtimeMode !== "legacy" || run.status !== "cancelled" || run.executionStage !== "settled" ||
      !run.controllerBootId || !run.startedAt || !run.finishedAt || !Number.isInteger(run.exitCode) ||
      run.controllerLeaseExpiresAt || run.resultJson?.acpToolInventoryComplete === false ||
      Number(run.resultJson?.acpPendingToolCount ?? 0) > 0) return false;
  const adapter = await historicalAdapterType(db, run);
  if (!adapter || !isConversationAdapter(adapter)) return false;
  const [event] = await db.select().from(heartbeatRunEvents).where(and(
    eq(heartbeatRunEvents.companyId, run.companyId), eq(heartbeatRunEvents.runId, run.id),
    or(and(isNull(heartbeatRunEvents.sourceEventId), eq(heartbeatRunEvents.eventType, "lifecycle"),
      eq(heartbeatRunEvents.message, "run cancelled")), inArray(heartbeatRunEvents.eventType,
      ["adapter.invoke", "native.process_start_requested", "native.process_identity_recorded"])),
  )).orderBy(desc(heartbeatRunEvents.seq)).limit(1);
  return event?.eventType === "lifecycle" && event.message === "run cancelled" &&
    event.payload?.status === "cancelled" && event.payload?.exitCode === run.exitCode &&
    event.createdAt >= run.finishedAt;
}

async function hasSettledNonConversationExecution(db: Db, run: typeof heartbeatRuns.$inferSelect) {
  if (run.executionStage !== "settled") return false;
  const adapter = await historicalAdapterType(db, run);
  return adapter !== null && !isConversationAdapter(adapter);
}

/** Cancellation changes admission. Process and lease evidence controls cleanup. */
export async function getAgentExecutionStopBlocker(db: Db, agentIds: string[]): Promise<ExecutionStopBlocker | null> {
  if (!agentIds.length) return null;
  const runs = await db.select().from(heartbeatRuns).where(inArray(heartbeatRuns.agentId, agentIds)).orderBy(asc(heartbeatRuns.id));
  const runIds = db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(inArray(heartbeatRuns.agentId, agentIds));
  const leases = await db.select().from(environmentLeases).where(or(
    inArray(environmentLeases.heartbeatRunId, runIds),
    inArray(sql`${environmentLeases.metadata}->>'agentId'`, agentIds),
  )).orderBy(asc(environmentLeases.id));
  const blockingLease = leases.find(lease => (!lease.releasedAt && !(lease.status === "retained" && lease.cleanupStatus === "success")) || lease.status === "pending_cleanup" || lease.cleanupStatus === "failed");
  if (blockingLease) return { runId: blockingLease.heartbeatRunId, leaseId: blockingLease.id, reason: "environment_cleanup" };
  const coordinators = await db.select().from(nativeRunFinalizations)
    .where(inArray(nativeRunFinalizations.runId, runIds)).orderBy(asc(nativeRunFinalizations.runId));
  const now = new Date();
  const abandoned = coordinators.filter(row => row.leaseOwner);
  const owned = abandoned.find(row => !row.leaseExpiresAt || row.leaseExpiresAt > now || row.resultId ||
      runs.find(run => run.id === row.runId)?.status !== "cancelled");
  if (owned) return { runId: owned.runId, reason: "finalization_owned" };
  const absent = (pid: number) => {
    try { process.kill(pid, 0); return false; }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
  };
  for (const coordinator of abandoned) {
    if (!coordinator.controllerPid || absent(coordinator.controllerPid)) continue;
    const observed = await readProcessStartedAt(coordinator.controllerPid).catch(() => null);
    if (!observed || !coordinator.controllerProcessStartedAt ||
        new Date(observed).getTime() === coordinator.controllerProcessStartedAt.getTime()) return { runId: coordinator.runId, reason: "controller_running" };
  }
  for (const run of runs) {
    if (!["succeeded", "failed", "cancelled", "timed_out", "interrupted"].includes(run.status)) return { runId: run.id, reason: "run_active" };
    if (run.controllerLeaseExpiresAt && run.controllerLeaseExpiresAt > new Date()) return { runId: run.id, reason: "controller_lease" };
    const runLeases = leases.filter(lease => lease.heartbeatRunId === run.id);
    if (runLeases.some(lease => lease.provider && lease.provider !== "local")) {
      if (run.status === "cancelled" && !runLeases.every(hasRemoteTerminationReceipt)) return { runId: run.id, reason: "remote_termination_missing" };
      continue;
    }
    let processAlive = Boolean(run.processPid && !absent(run.processPid));
    let groupAlive = Boolean(run.processGroupId && !absent(-run.processGroupId));
    if (processAlive && run.processStartedAt) {
      const observed = await readProcessStartedAt(run.processPid!).catch(() => null);
      if (observed && new Date(observed).getTime() !== run.processStartedAt.getTime()) {
        processAlive = false;
        if (run.processGroupId === run.processPid) groupAlive = false;
      }
    }
    if (processAlive || groupAlive) return { runId: run.id, reason: "process_running" };
    if (run.status !== "cancelled" || !run.startedAt) continue;
    if (run.runtimeMode === "native" && !run.processPid && !run.processGroupId &&
        !await hasNativeLocalProcessStop(db, run.companyId, run.id) &&
        !await isCancelledNativeStartup(db, run, coordinators.find(row => row.runId === run.id))) return { runId: run.id, reason: "stop_proof_missing" };
    if (run.runtimeMode === "legacy" && !run.processPid && !run.processGroupId &&
        (run.resultJson?.executionCancellation as Record<string, unknown> | undefined)?.state !== "acknowledged" &&
        !await hasSettledNonConversationExecution(db, run) &&
        !await hasHistoricalLegacyCompletion(db, run) &&
        !await isCancelledNativeStartup(db, run, coordinators.find(row => row.runId === run.id))) return { runId: run.id, reason: "stop_proof_missing" };
  }
  // Release an expired owner only after its cancelled execution has stop proof.
  for (const coordinator of abandoned) {
    const [cleared] = await db.update(nativeRunFinalizations).set({ leaseOwner: null, leaseExpiresAt: null, updatedAt: now })
      .where(and(eq(nativeRunFinalizations.runId, coordinator.runId),
        eq(nativeRunFinalizations.leaseOwner, coordinator.leaseOwner!),
        eq(nativeRunFinalizations.leaseExpiresAt, coordinator.leaseExpiresAt!),
        eq(nativeRunFinalizations.controllerGeneration, coordinator.controllerGeneration),
        eq(nativeRunFinalizations.phase, coordinator.phase), isNull(nativeRunFinalizations.resultId)))
      .returning({ runId: nativeRunFinalizations.runId });
    if (!cleared) return { runId: coordinator.runId, reason: "finalization_changed" };
  }
  return null;
}

export async function agentExecutionsHaveStopped(db: Db, agentIds: string[]) {
  return await getAgentExecutionStopBlocker(db, agentIds) === null;
}
