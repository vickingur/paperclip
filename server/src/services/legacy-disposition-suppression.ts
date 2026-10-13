import { and, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import { environmentLeases, heartbeatRunEvents, heartbeatRuns, issueRecoveryActions, issues, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { hasSettledExecutionActions } from "@paperclipai/adapter-utils/execution-action-inventory";
import { hasWorkspaceRestoreFailure } from "@paperclipai/shared";
import { hasRequiredWorkspaceRecovery } from "./workspace-restore-recovery-state.js";
import { hasUnrestoredRemoteWorkspace } from "./legacy-workspace-restore-recovery.js";
import { hasRemoteTerminationReceipt } from "./remote-execution-termination.js";
import { PROCESS_IDENTITY_RECORDED, PROCESS_START_REQUESTED } from "./native-local-process-stop.js";
import { readRunCancellation } from "./run-cancellation.js";
import { logActivity } from "./activity-log.js";

type Run = typeof heartbeatRuns.$inferSelect;
const ERROR = "legacy_disposition_repair_suppressed";

/** Only the executor writes this at the boundary preceding adapter handoff.
 * A cancellation message or an empty action summary is never a substitute. */
export function dispositionSuppressionReceipt(run: Run, reason: string) {
  return { schema: "paperclip.disposition-suppression.v1", companyId: run.companyId,
    runId: run.id, issueId: run.contextSnapshot?.issueId, reason,
    providerDispatchStarted: false, boundaryAt: new Date().toISOString() };
}

export async function isLegacyDispositionSuppressionVerified(db: Db, run: Run): Promise<boolean> {
  const receipt = run.resultJson?.dispositionSuppression as Record<string, unknown> | undefined;
  const cancellation = readRunCancellation(run.resultJson);
  if (run.runtimeMode !== "legacy" || run.status !== "cancelled" || run.errorCode !== ERROR ||
      receipt?.schema !== "paperclip.disposition-suppression.v1" || receipt.companyId !== run.companyId ||
      receipt.runId !== run.id || typeof receipt.issueId !== "string" || receipt.issueId !== run.contextSnapshot?.issueId ||
      receipt.providerDispatchStarted !== false || typeof receipt.reason !== "string" || !receipt.reason ||
      typeof receipt.boundaryAt !== "string" || !Number.isFinite(Date.parse(receipt.boundaryAt)) ||
      typeof receipt.settledAt !== "string" || !Number.isFinite(Date.parse(receipt.settledAt)) ||
      !run.finishedAt || Date.parse(receipt.settledAt) < run.finishedAt.getTime() ||
      Date.parse(receipt.boundaryAt) > run.finishedAt.getTime() ||
      cancellation?.source !== "control_plane" || cancellation.initiator.type !== "system" || !cancellation.expected ||
      run.resultJson?.operatorInterrupted || run.resultJson?.cancelledByUserId ||
      run.processPid !== null || run.processGroupId !== null || run.processStartedAt !== null ||
      run.nativeIssueId !== null || run.nativeSessionId !== null || run.sessionIdAfter !== null ||
      run.controllerLeaseExpiresAt !== null || run.executionStage !== "settled" ||
      hasWorkspaceRestoreFailure(run.resultJson) || hasRequiredWorkspaceRecovery(run.resultJson) ||
      run.resultJson?.acpToolInventoryComplete === false || Number(run.resultJson?.acpPendingToolCount ?? 0) > 0 ||
      (run.resultJson?.executionRecovery as Record<string, unknown> | undefined)?.providerWorkStarted === true) return false;
  const inventory = run.resultJson?.executionActionInventory;
  if (inventory != null && (!hasSettledExecutionActions(inventory) || inventory.dispatch !== "not_attempted" || inventory.actions.length)) return false;
  if (await hasUnrestoredRemoteWorkspace(db, run)) return false;
  const [native] = await db.select({ id: nativeRunFinalizations.runId }).from(nativeRunFinalizations).where(and(
    eq(nativeRunFinalizations.companyId, run.companyId), eq(nativeRunFinalizations.runId, run.id),
  )).limit(1);
  if (native) return false;
  const leases = await db.select().from(environmentLeases).where(and(
    eq(environmentLeases.companyId, run.companyId), eq(environmentLeases.heartbeatRunId, run.id),
  ));
  if (leases.some(lease => lease.provider === "local"
    ? lease.providerLeaseId !== null || !lease.releasedAt || lease.cleanupStatus !== "success" || !["released", "expired", "failed"].includes(lease.status)
    : !hasRemoteTerminationReceipt(lease))) return false;
  const [execution] = await db.select({ id: heartbeatRunEvents.id }).from(heartbeatRunEvents).where(and(
    eq(heartbeatRunEvents.companyId, run.companyId), eq(heartbeatRunEvents.runId, run.id),
    or(isNotNull(heartbeatRunEvents.sourceEventId),
      // Any tool execution receipt contradicts a never-dispatched turn, even
      // when historical completion/progress rows lack a source event ID.
      sql`${heartbeatRunEvents.eventType} LIKE 'tool.execution.%'`, inArray(heartbeatRunEvents.eventType, [
      "adapter.invoke", PROCESS_START_REQUESTED, PROCESS_IDENTITY_RECORDED, "harness.ready", "session.started",
      "session.resumed", "session.updated", "turn.started", "provider.event", "provider.rpc_result", "tool.execution.started",
    ])),
  )).limit(1);
  return !execution;
}

/** Exact executor cleanup only. Correct its false incident, retaining the
 * recorded disposition and every other hold. Successor admission stays queued. */
export async function settleLegacyDispositionSuppression(db: Db, input: { run: Run; providerDispatchStarted: boolean }): Promise<Run | null> {
  if (input.providerDispatchStarted || input.run.errorCode !== ERROR || typeof input.run.contextSnapshot?.issueId !== "string") return null;
  return db.transaction(async tx => {
    const [task] = await tx.select().from(issues).where(and(eq(issues.companyId, input.run.companyId),
      eq(issues.id, String(input.run.contextSnapshot!.issueId)))).for("update");
    const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, input.run.companyId),
      eq(heartbeatRuns.id, input.run.id))).for("update");
    if (!task || !run) return null;
    const now = new Date();
    const candidate = { ...run, resultJson: { ...run.resultJson, dispositionSuppression: {
      ...(run.resultJson?.dispositionSuppression as Record<string, unknown> | undefined),
      settledAt: (run.resultJson?.dispositionSuppression as Record<string, unknown> | undefined)?.settledAt ?? now.toISOString(),
    } } };
    if (!(await isLegacyDispositionSuppressionVerified(tx as unknown as Db, candidate))) return null;
    const holds = await tx.select().from(issueRecoveryActions).where(and(
      eq(issueRecoveryActions.companyId, run.companyId), eq(issueRecoveryActions.sourceIssueId, task.id),
      eq(issueRecoveryActions.cause, "legacy_execution_requires_reconciliation"),
      eq(issueRecoveryActions.fingerprint, `legacy-execution:${run.id}`),
      sql`${issueRecoveryActions.evidence}->>'runId' = ${run.id}`,
      or(inArray(issueRecoveryActions.status, ["active", "escalated"]), sql`${issueRecoveryActions.evidence}->'automaticRecovery'->>'replay' = 'blocked'`),
    )).for("update");
    if (holds.some(hold => hasWorkspaceRestoreFailure(hold.evidence) || hasRequiredWorkspaceRecovery(hold.evidence) ||
        hold.evidence.executionReconciliation || hold.evidence.explicitUserContinuation ||
        hold.evidence.dependencyClosureContinuation || hold.evidence.boardExecutionReset)) return null;
    if (!holds.length && await isLegacyDispositionSuppressionVerified(tx as unknown as Db, run)) return run;
    const [settled] = await tx.update(heartbeatRuns).set({ resultJson: candidate.resultJson, updatedAt: now })
      .where(eq(heartbeatRuns.id, run.id)).returning();
    for (const hold of holds) await tx.update(issueRecoveryActions).set({ status: "resolved", outcome: "false_positive",
      resolvedAt: now, updatedAt: now, resolutionNote: "Verified system suppression before provider dispatch and completed cleanup.",
      evidence: { ...hold.evidence, dispositionSuppression: candidate.resultJson.dispositionSuppression,
        ...(hold.evidence.automaticRecovery ? { automaticRecovery: { ...(hold.evidence.automaticRecovery as Record<string, unknown>), replay: "allowed" } } : {}) },
    }).where(eq(issueRecoveryActions.id, hold.id));
    if (holds.length) await logActivity(tx as unknown as Db, { companyId: run.companyId, actorType: "system", actorId: "system",
      action: "issue.recovery_action_resolved", entityType: "issue", entityId: task.id, agentId: run.agentId, runId: run.id,
      details: { reason: ERROR, recoveryActionIds: holds.map(hold => hold.id) },
    });
    return settled;
  });
}
