import { conflict } from "../errors.js";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import {
  executionResetIdentity, findCommittedExecutionReset,
  type ExecutionResetIntent,
} from "./execution-reset-idempotency.js";

type LockedIssue = typeof issues.$inferSelect;
type ResetAdmission = { previousRunId: string };

/** Transaction producer for authenticated board reset; public wakes cannot select it.
 * The queue must supply its full policy and stopped-execution admission using
 * this transaction. No provider or post-commit delivery may run in the callback.
 * Its returned predecessor must match the board's exact inspected holder.
 */
export async function commitExecutionReset(
  db: Db,
  intent: ExecutionResetIntent,
  admit: (input: { db: Db; issue: LockedIssue; intent: ExecutionResetIntent;
    resetId: string; successorRunId: string }) => Promise<ResetAdmission | null>,
) {
  const identity = executionResetIdentity(intent);
  return db.transaction(async tx => {
    const lockedDb = tx as unknown as Db;
    const [issue] = await tx.select().from(issues).where(and(
      eq(issues.companyId, intent.companyId), eq(issues.id, intent.issueId),
    )).for("update");
    if (!issue) throw conflict("execution_reset_source_unavailable");
    // A retry is a read of the original commit, even if ownership or gates
    // changed after completion. Never repeat cleanup/admission for a retry.
    const saved = await findCommittedExecutionReset(lockedDb, intent);
    if (saved) return saved;
    if (!issue.assigneeAgentId || issue.assigneeUserId || ["done", "cancelled"].includes(issue.status))
      throw conflict("execution_reset_source_unavailable");
    const resetId = randomUUID(), successorRunId = randomUUID();
    const admission = await admit({ db: lockedDb, issue, intent, resetId, successorRunId });
    if (!admission) throw conflict("execution_reset_admission_rejected");
    if (admission.previousRunId !== intent.expectedHoldingRunId)
      throw conflict("execution_reset_receipt_mismatch");
    const response = { resetId, issueId: issue.id, successorRunId, previousRunId: admission.previousRunId };
    const boardExecutionReset = {
      resetId, actorId: intent.principalId, fingerprint: intent.fingerprint,
      expectedHoldingRunId: intent.expectedHoldingRunId,
      expectedRecoveryActionId: intent.expectedRecoveryActionId,
      previousRunId: admission.previousRunId, acknowledgeFreshHistoryAwareTurn: true,
    };
    const now = new Date();
    await tx.insert(agentWakeupRequests).values({
      id: resetId, companyId: issue.companyId, agentId: issue.assigneeAgentId,
      source: "on_demand", triggerDetail: "manual", reason: "execution_reset",
      status: "coalesced", runId: successorRunId, finishedAt: now,
      requestedByActorType: "user", requestedByActorId: intent.principalId,
      idempotencyKey: identity.scopedKey,
      payload: { issueId: issue.id, boardExecutionReset,
        executionResetCommit: { payloadDigest: identity.payloadDigest, response } },
    });
    await tx.insert(heartbeatRuns).values({
      id: successorRunId, companyId: issue.companyId, agentId: issue.assigneeAgentId,
      scopeKind: "issue", issueId: issue.id, invocationSource: "on_demand",
      triggerDetail: "manual", status: "queued", responsibleUserId: intent.principalId,
      wakeupRequestId: resetId, sessionIdBefore: null,
      contextSnapshot: { issueId: issue.id, wakeReason: "execution_reset",
        forceFreshSession: true, previousRunId: admission.previousRunId, boardExecutionReset },
    });
    // Validate the actual persisted shape before committing any admission write.
    return (await findCommittedExecutionReset(lockedDb, intent))!;
  });
}
