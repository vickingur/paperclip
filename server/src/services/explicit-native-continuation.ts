import { collectExecutionResetInspection } from "./execution-reset-inspection.js";
import { issueService } from "./issues.js";
import { issueTreeControlService } from "./issue-tree-control.js";
import { hasSettledExecutionActions } from "@paperclipai/adapter-utils/execution-action-inventory";
import { verifyDependencyClosureProof } from "./dependency-closure-proof.js";
import { readRunCancellation } from "./run-cancellation.js";
import { isExplicitContinuationRetryClaim } from "./explicit-continuation-retry-claim.js";
import { hasRequiredWorkspaceRecovery } from "./workspace-restore-recovery-state.js";
import { createHash } from "node:crypto";
import { appendHeartbeatRunEvent } from "./heartbeat-run-events.js";
import { canContinueCancelledRun } from "./run-cancellation.js";
import { readQueuedInteractionResponse } from "./queued-interaction-response.js";
import { isCancelledNativeStartup } from "./cancelled-native-startup.js";
import { verifyStoppedExecutionEnvironment } from "./execution-stop-proof.js";
import { z } from "zod";
import { and, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import {
  agents, agentWakeupRequests, approvals, environmentLeases, issueApprovals, issueThreadInteractions,
  heartbeatRuns, issueComments, issueRecoveryActions,
  issues, nativeRunFinalizations, nativeRunResults, type Db,
} from "@paperclipai/db";
import { executionBlockerPredicate, getExecutionBlocker } from "./execution-blocker.js";
import { buildExecutionContinuation } from "./execution-continuation.js";
import { adapterExecutionControls } from "./adapter-execution-control.js";
import { persistActivity } from "./activity-log.js";
import { activeIssueInteractionCondition } from "./issue-question-context.js";

import { historicalAdapterType, isConversationAdapter } from "./conversation-continuation.js";
import { queuedCommentIdsFromWakePayload } from "./issue-queued-comment-queue.js";

type Run = typeof heartbeatRuns.$inferSelect;
const terminal = ["failed", "interrupted", "timed_out", "cancelled"];

/** Validate the whole saved queue, preserving order and original authors.
 * Call again under the task lock before adopting IDs into a new run.
 */
export async function undeliveredLegacyUserCommentIds(
  db: Db, companyId: string, issueId: string, agentId: string, commentIds: string[],
): Promise<string[]> {
  if (!commentIds.length) return [];
  const comments = await db.select({ id: issueComments.id }).from(issueComments).where(and(
    eq(issueComments.companyId, companyId), eq(issueComments.issueId, issueId),
    inArray(issueComments.id, commentIds), eq(issueComments.authorType, "user"),
    isNull(issueComments.createdByRunId), isNull(issueComments.deletedAt),
    sql`nullif(trim(${issueComments.body}), '') is not null`,
    sql`nullif(trim(${issueComments.authorUserId}), '') is not null`,
  ));
  const valid = new Set(comments.map(comment => comment.id));
  const previous = await db.select({ context: heartbeatRuns.contextSnapshot }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agentId),
    sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issueId}`,
    // A queued turn cancelled before dispatch has not consumed input, whatever
    // cancelled it (pause, stale assignment, or rejected admission). Reserved
    // native identity/process metadata is not proof that its prompt was sent.
    // Admission separately verifies process termination before a new turn.
    sql`not (${heartbeatRuns.status} = 'cancelled' and ${heartbeatRuns.startedAt} is null)`,
    or(...commentIds.map(id => or(
      sql`${heartbeatRuns.contextSnapshot}->>'wakeCommentId' = ${id}`,
      sql`${heartbeatRuns.contextSnapshot}->'wakeCommentIds' @> ${JSON.stringify([id])}::jsonb`,
    ))),
  ));
  for (const { context } of previous) {
    if (typeof context?.wakeCommentId === "string") valid.delete(context.wakeCommentId);
    if (Array.isArray(context?.wakeCommentIds)) {
      for (const id of context.wakeCommentIds) if (typeof id === "string") valid.delete(id);
    }
  }
  return commentIds.filter(id => valid.has(id));
}

/** Called under the issue lock, in the transaction that creates the new turn.
 * A user request or positively settled trusted dependency closure authorizes a
 * fresh turn, never replay of the failed run.
 * Unknown action outcomes and all prior records stay intact.
 */
type AdmissionInput = {
  db: Db; companyId: string; issueId: string; agentId: string;
  actorType: string | null | undefined; actorId: string | null | undefined;
  reason: string | null; commentId: string | null; successorRunId: string;
  failedRunId?: string | null;
  /** Server-recorded board intent to send an existing legacy message queue. */
  queuedCommentInterruptId?: string;
  /** Internal delivery of an unconsumed, user-authored saved queue entry. */
  queuedCommentRequestId?: string;
  dryRun?: boolean;
  onBlocked?: (reason: string, message: string) => void;
};
type Admission = { previousRunId: string; commentId: string | null; failedRunId?: string };

export async function admitExplicitNativeContinuation(input: AdmissionInput): Promise<Admission | null> {
  return admitStoppedContinuation(input);
}

/** Internal closure intent is proven from the server receipt, never actor labels.
 * The queue owns the issue lock and the transaction creating the successor. */
export async function admitDependencyClosureContinuation(input: AdmissionInput & { receiptId: unknown }): Promise<Admission | null> {
  if (input.reason !== "issue_blockers_resolved") return null;
  const proof = await verifyDependencyClosureProof(input.db, input);
  if (!proof) return null;
  return admitStoppedContinuation(input, proof);
}

type BoardResetIntent = { resetId: string; fingerprint: string; expectedHoldingRunId: string; expectedRecoveryActionId: string };

/** Internal helper for reset orchestration, never a public wake intent. Caller
 * supplies an authenticated board principal and creates the durable receipt and
 * successor in this same transaction. This helper does not dispatch a provider.
 */
export async function admitBoardExecutionReset(input: AdmissionInput & {
  resetId: string; expectedHoldingRunId: string; expectedRecoveryActionId: string;
  fingerprint: string; acknowledgeFreshHistoryAwareTurn: boolean;
}): Promise<Admission | null> {
  const reject = (reason: string) => { input.onBlocked?.(reason, "Execution reset requires current, safe evidence."); return null; };
  if (input.actorType !== "user" || !input.actorId || input.reason !== "execution_reset" ||
      input.commentId !== null || input.failedRunId || input.queuedCommentInterruptId || input.queuedCommentRequestId ||
      input.acknowledgeFreshHistoryAwareTurn !== true ||
      ![input.resetId, input.expectedHoldingRunId, input.expectedRecoveryActionId].every(id => z.string().guid().safeParse(id).success))
    return reject("invalid_reset_intent");
  // Use the ordinary issue serialization fence. Finalizers/source rows are
  // locked by the shared evaluator below, in its existing claim lock order.
  const [task] = await input.db.select().from(issues).where(and(
    eq(issues.companyId, input.companyId), eq(issues.id, input.issueId),
  )).for("update");
  if (!task || task.assigneeUserId) return reject("source_unavailable");
  const inspection = await collectExecutionResetInspection(input.db, input.companyId, input.issueId);
  if (!inspection || inspection.fingerprint !== input.fingerprint || !inspection.holds.some(hold =>
      hold.recoveryActionId === input.expectedRecoveryActionId && hold.holdingRunId === input.expectedHoldingRunId))
    return reject("stale_reset_expectations");
  // Preview must classify every affected hold as settled. A missing ledger
  // stays unknown even if a later startup proof might establish no dispatch.
  if (inspection.holds.some(hold => hold.outcomeClassification !== "settled"))
    return reject("unknown_outcome_reconciliation_required");
  return admitStoppedContinuation(input, undefined, { resetId: input.resetId,
    fingerprint: input.fingerprint, expectedHoldingRunId: input.expectedHoldingRunId, expectedRecoveryActionId: input.expectedRecoveryActionId });
}

async function admitStoppedContinuation(input: AdmissionInput, dependency?: { receiptId: string; fingerprint: string; createdAt: Date }, board?: BoardResetIntent): Promise<Admission | null> {
  const strict = Boolean(dependency || board);
  const { db, companyId, issueId, agentId, actorId, commentId } = input;
  const blocked = (reason: string, message: string) => { input.onBlocked?.(reason, message); return null; };
  if (!strict && (input.actorType !== "user" || !actorId)) return null;
  const retry = input.reason === "retry_failed_run" &&
    z.string().guid().safeParse(input.failedRunId).success;
  if (!strict && !retry && !input.queuedCommentInterruptId && (!commentId || !z.string().guid().safeParse(commentId).success ||
      !["issue_commented", "issue_reopened_via_comment"].includes(input.reason ?? ""))) return null;
  const [task] = await db.select().from(issues).where(and(
    eq(issues.companyId, companyId), eq(issues.id, issueId),
  ));
  if (!task || task.assigneeAgentId !== agentId || ["done", "cancelled"].includes(task.status)) return null;
  if (strict && (await issueTreeControlService(db).getActivePauseHoldGate(companyId, issueId) ||
      (task.executionState?.status === "pending" && ["review", "approval"].includes(String(task.executionState?.currentStageType)))))
    return blocked("task_gate", "Task pause or required review must be resolved before continuation.");
  if (strict && task.executionRunId) {
    const [holder] = await db.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, task.executionRunId),
    ));
    if (isExplicitContinuationRetryClaim(task, holder)) return blocked("explicit_retry_claim", "An explicit continuation claim owns this task.");
  }
  const [interruptQueue] = input.queuedCommentInterruptId ? await db.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.id, input.queuedCommentInterruptId),
    eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.agentId, agentId),
    eq(agentWakeupRequests.status, "deferred_issue_execution"),
    sql`${agentWakeupRequests.payload}->>'issueId' = ${issueId}`,
    sql`${agentWakeupRequests.payload}->'queuedCommentInterrupt'->>'actorId' = ${actorId}`,
  )) : [];
  const response = interruptQueue
    ? await readQueuedInteractionResponse(db, companyId, issueId, interruptQueue.payload) : null;
  const queuedInterrupt = Boolean(interruptQueue && (response || (commentId &&
    queuedCommentIdsFromWakePayload(interruptQueue.payload).includes(commentId))));
  if (input.queuedCommentInterruptId && !queuedInterrupt) return null;
  const [savedQueue] = input.queuedCommentRequestId ? await db.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.id, input.queuedCommentRequestId),
    eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.agentId, agentId),
    eq(agentWakeupRequests.status, "deferred_issue_execution"),
    sql`${agentWakeupRequests.payload}->>'issueId' = ${issueId}`,
  )) : [];
  const queuedRequest = Boolean(savedQueue && commentId &&
    !savedQueue.idempotencyKey?.startsWith("chat-inbound:") &&
    queuedCommentIdsFromWakePayload(savedQueue.payload).includes(commentId));
  if (input.queuedCommentRequestId && !queuedRequest) return null;
  let partiallyDeliveredQueue = false;
  if (queuedRequest) {
    const ids = queuedCommentIdsFromWakePayload(savedQueue!.payload);
    const undelivered = await undeliveredLegacyUserCommentIds(db, companyId, issueId, agentId, ids);
    // A partly consumed queue still owns its remaining input. Admission and
    // adoption both recheck the durable queue and discard already delivered IDs.
    if (undelivered.at(-1) !== commentId) return null;
    partiallyDeliveredQueue = undelivered.length !== ids.length;
  }
  const [comment] = strict || retry || response ? [] : await db.select().from(issueComments).where(and(
    eq(issueComments.companyId, companyId), eq(issueComments.issueId, issueId),
    eq(issueComments.id, commentId!), eq(issueComments.authorType, "user"),
    queuedInterrupt ? undefined : eq(issueComments.authorUserId, actorId!), isNull(issueComments.createdByRunId),
    isNull(issueComments.deletedAt),
  ));
  if (!strict && !retry && !response && !comment?.body.trim()) return null;
  const authorizedAt = response?.comment.createdAt ?? comment?.createdAt ?? new Date();
  const [agent] = await db.select().from(agents).where(and(eq(agents.companyId, companyId), eq(agents.id, agentId)));
  if (board && (!agent || !["idle", "running"].includes(agent.status))) return blocked("agent_unavailable", "The assigned agent is paused or unavailable.");
  if (board && !(await issueService(db).getDependencyReadiness(issueId)).isDependencyReady) return blocked("issue_dependencies_blocked", "Resolve dependencies before reset.");
  if (!agent || (!isConversationAdapter(agent.adapterType) && agent.adapterType !== "paperclip_runner")) return null;
  if (queuedInterrupt && !isConversationAdapter(agent.adapterType) && !response?.source.requiresFreshSession) return null;
  const actions = await db.select().from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, companyId), eq(issueRecoveryActions.sourceIssueId, issueId),
    executionBlockerPredicate(),
  )).orderBy(issueRecoveryActions.id).for("update");
  if (!actions.length) return null;
  const blocker = await getExecutionBlocker(db, companyId, issueId);
  if (blocker && blocker.recoveryActionId === null) return null;
  const [pendingInteraction] = await db.select({ id: issueThreadInteractions.id }).from(issueThreadInteractions).where(and(
    eq(issueThreadInteractions.companyId, companyId), eq(issueThreadInteractions.issueId, issueId),
    eq(issueThreadInteractions.status, "pending"),
    strict ? undefined : activeIssueInteractionCondition({ responsibleUserId: actorId! }),
  )).limit(1);
  const [pendingApproval] = await db.select({ id: approvals.id }).from(issueApprovals).innerJoin(approvals, and(
    eq(approvals.id, issueApprovals.approvalId), eq(approvals.companyId, companyId),
  )).where(and(eq(issueApprovals.companyId, companyId), eq(issueApprovals.issueId, issueId),
    inArray(approvals.status, ["pending", "revision_requested"]))).limit(1);
  if (pendingInteraction || pendingApproval) return blocked("decision_pending", "A pending approval or question must be resolved before this message can start.");

  const sources: Run[] = [];
  const stoppedSessions: Array<{ evidence: Record<string, unknown>; retire: () => boolean }> = [];
  const cancelledStartupIds = new Set<string>();
  for (const action of actions) {
    if (strict && (hasRequiredWorkspaceRecovery(action.evidence) || action.evidence.workspaceRestoreFailure === "restore_unsafe_archive"))
      return blocked("workspace_repair_required", "Repair the retained workspace before continuation.");
    const runId = action.evidence.runId ?? action.evidence.sourceRunId;
    if (typeof runId !== "string") return blocked("source_missing", "The stopped run could not be identified. Your message is saved.");
    // Text comparison keeps malformed historical evidence a hold, not a UUID cast error.
    let [run] = await db.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, companyId), sql`${heartbeatRuns.id}::text = ${runId}`,
    ));
    if (!run || run.agentId !== agentId || !terminal.includes(run.status) ||
        (run.nativeIssueId ?? run.contextSnapshot?.issueId) !== issueId ||
        !run.finishedAt) return blocked("source_unavailable", "The previous execution has not finished or its owner changed. Your message is saved.");
    if (!strict && !queuedInterrupt && !queuedRequest && authorizedAt <= run.finishedAt) return blocked("message_predates_stop", "This message arrived before the previous run stopped. Send a new message to continue.");
    if (adapterExecutionControls.has(run.id)) return blocked("execution_settling", "Waiting for the previous run to stop. Your message will start automatically.");
    const unusedAdmission = run.status === "cancelled" && !run.startedAt &&
      run.errorCode === "execution_reconciliation_required" &&
      !run.processPid && !run.processGroupId && !run.nativeSessionId;
    const legacyUserTurn = run.runtimeMode === "legacy" &&
      action.cause === "legacy_execution_requires_reconciliation" &&
      isConversationAdapter(agent.adapterType);
    // Saved input is a request for a new turn, never permission to undo an
    // operator Stop or redeliver a message already consumed by this run.
    if (queuedRequest && !queuedInterrupt && (run.contextSnapshot?.wakeCommentId === commentId ||
        (Array.isArray(run.contextSnapshot?.wakeCommentIds) && run.contextSnapshot.wakeCommentIds.includes(commentId)))) return null;
    if (legacyUserTurn) {
      const historicalAdapter = await historicalAdapterType(db, run);
      // A settings change never converts a known process/webhook execution into
      // a conversation. Those adapters retain their reconciliation contract.
      if ((strict && !historicalAdapter) || (historicalAdapter && !isConversationAdapter(historicalAdapter))) return null;
    }
    // For pre-upgrade rows without adapter evidence, only a new explicit user
    // turn is allowed, after the termination proofs below. This does not infer
    // an old adapter type, certify old outcomes, or authorize automatic replay.
    const [coordinator] = await db.select().from(nativeRunFinalizations).where(and(
      eq(nativeRunFinalizations.companyId, companyId), eq(nativeRunFinalizations.runId, run.id),
    )).for("update");
    // Same lock order as the native claim. Re-read the run while holding both
    // locks before accepting the never-claimed startup proof.
    const [lockedRun] = await db.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, run.id),
    )).for("update");
    if (!lockedRun || lockedRun.status !== run.status || lockedRun.agentId !== run.agentId ||
        lockedRun.finishedAt?.getTime() !== run.finishedAt.getTime()) return null;
    run = lockedRun;
    if (run.resultJson?.workspaceRestoreFailure === "restore_unsafe_archive" || hasRequiredWorkspaceRecovery(run.resultJson)) {
      return blocked("workspace_repair_required", "Verify safe workspace staging or repair before continuing. Your message is saved.");
    }
    const cancelledStartup = await isCancelledNativeStartup(db, run, coordinator);
    // Automatic startup admission supports only a locked, never-claimed native
    // coordinator. Historical pre-selection Stop receipts remain explicit-only.
    const automaticStartup = Boolean(strict && cancelledStartup && run.runtimeMode === "native");
    if (strict) {
      if (dependency && dependency.createdAt <= run.finishedAt!) return blocked("closure_predates_stop", "The closure predates the stopped execution.");
      const cancellation = readRunCancellation(run.resultJson);
      if (!(board && board.expectedHoldingRunId === run.id) && (cancellation?.source === "operator" || cancellation?.initiator.type === "user" ||
          run.resultJson?.operatorInterrupted === true || run.resultJson?.cancelledByUserId ||
          ["user", "board"].includes(String(run.resultJson?.cancelledByActorType)) ||
          ["user", "board"].includes(String(run.resultJson?.interruptedByActorType)) ||
          (run.resultJson?.startupCancellation && !automaticStartup) ||
          (run.status === "cancelled" && !automaticStartup && (!cancellation || !["shutdown", "control_plane", "provider", "transport"].includes(cancellation.source)))))
        return blocked("operator_stop_or_unknown_cancellation", "The stopped execution needs explicit inspection before continuation.");
      // Never-claimed proof positively establishes no provider/tool dispatch.
      // A contradictory retained inventory still fails closed.
      const inventory = run.resultJson?.executionActionInventory;
      if (automaticStartup && inventory != null &&
          (!hasSettledExecutionActions(inventory) || inventory.dispatch !== "not_attempted" || inventory.actions.length !== 0))
        return blocked("contradictory_dispatch_evidence", "The startup receipt contradicts retained action evidence.");
      if (!(automaticStartup && inventory == null) && !hasSettledExecutionActions(inventory))
        return blocked(board ? "unknown_outcome_reconciliation_required" : "unknown_action_outcomes", "Every action needs recorded settlement before continuation.");
      if (run.controllerLeaseExpiresAt && run.controllerLeaseExpiresAt > new Date())
        return blocked("controller_settling", "The previous controller still holds a lease.");
      if (action.evidence.explicitUserContinuation || action.evidence.dependencyClosureContinuation || action.evidence.boardExecutionReset)
        return blocked("replacement_claim", "The previous execution already has a continuation claim.");
      if (!legacyUserTurn && run.runtimeMode !== "native") return null;
    }
    if (partiallyDeliveredQueue && run.runtimeMode !== "native" && !unusedAdmission && !cancelledStartup) return null;
    if ((queuedInterrupt || queuedRequest) && !legacyUserTurn && !unusedAdmission &&
        !(queuedRequest && run.runtimeMode === "native" &&
          (run.status !== "cancelled" || authorizedAt > run.finishedAt!)) &&
        !(queuedRequest && cancelledStartup && authorizedAt > run.finishedAt!) &&
        !(queuedInterrupt && response?.source.requiresFreshSession && run.runtimeMode === "native")) return null;
    // A saved native message sent after Stop is a new user direction. Older
    // input cannot restart a cancelled run merely because it is still queued.
    if (queuedRequest && !queuedInterrupt && run.status === "cancelled" && !unusedAdmission &&
        !canContinueCancelledRun(run) && !(run.runtimeMode === "native" && authorizedAt > run.finishedAt!) &&
        !(cancelledStartup && authorizedAt > run.finishedAt!)) return null;
    if (retry && run.status === "cancelled" && !canContinueCancelledRun(run) && !cancelledStartup)
      return blocked("cancelled_by_operator", "Inspect the stopped run and send a new message to continue.");
    if (cancelledStartup) cancelledStartupIds.add(run.id);
    if (run.runtimeMode !== "native" && !unusedAdmission && !legacyUserTurn && !cancelledStartup) return null;
    // A provider failure can finish the normal result/assessment commit path.
    // Its accepted failed result is immutable history, not a live controller.
    // An admitted fresh turn may pass this gate; the process/lease stop proofs
    // below remain mandatory and no previous action is automatically replayed.
    const [committedFailure] = coordinator?.phase === "committed" && coordinator.resultId && run.status === "failed"
      ? await db.select({ id: nativeRunResults.id }).from(nativeRunResults).where(and(
          eq(nativeRunResults.companyId, companyId), eq(nativeRunResults.issueId, issueId),
          eq(nativeRunResults.runId, run.id), eq(nativeRunResults.id, coordinator.resultId),
          eq(nativeRunResults.schemaStatus, "accepted"),
          sql`${nativeRunResults.resultJson}->'terminal'->>'runTerminalState' = 'failed'`,
        )).limit(1)
      : [];
    // A terminal failure may retain a result accepted before checkpoint or
    // cleanup failed. That immutable result is history, not an active commit.
    // Keep it intact and require the same controller/process/lease stop proofs
    // before admitting new user input; never apply or replay the old result.
    if (!cancelledStartup && coordinator && (
        (coordinator.phase !== "terminal_failure" && !committedFailure) || coordinator.leaseOwner ||
        coordinator.failureDetail?.successorRunId)) return blocked("controller_settling",
          run.status === "cancelled" && !coordinator.leaseOwner
            ? "The cancelled run still needs verified cleanup. Your message is saved. Inspect the run and its environment for details."
            : "Waiting for the previous run to finish recovery. Your message will start automatically.");
    const stopProof = await verifyStoppedExecutionEnvironment({
      db, companyId, run, unusedAdmission: strict ? false : unusedAdmission, cancelledStartup: strict ? automaticStartup : cancelledStartup, retry, dryRun: input.dryRun,
    });
    if (!stopProof.ok) return blocked(stopProof.reason, stopProof.message);
    if (stopProof.stoppedSession) stoppedSessions.push(stopProof.stoppedSession);
    sources.push(run);
  }
  const nativeSources = sources.filter(run => run.runtimeMode === "native");
  const executedSources = sources.filter(run => run.runtimeMode === "native" || run.errorCode !== "execution_reconciliation_required" || run.startedAt);
  if (!executedSources.length || (retry && !sources.some(run => run.id === input.failedRunId))) return null;
  const [active] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, companyId),
    or(eq(heartbeatRuns.nativeIssueId, issueId), sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issueId}`),
    inArray(heartbeatRuns.status, ["running", "queued", "scheduled_retry"]),
    ne(heartbeatRuns.id, input.successorRunId),
  )).limit(1);
  if (active) return blocked("execution_active", "Waiting for the current run. Your message is saved.");
  const previous = executedSources.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]!;
  // Prove required task history is available before retiring any hold.
  await buildExecutionContinuation({ db, companyId, issueId, agentId,
    context: { previousRunId: previous.id, wakeCommentId: commentId },
    summary: null, exposeLowTrustRaw: false });
  if (board) {
    if ([task.executionRunId, task.checkoutRunId].some(id => id && !sources.some(run => run.id === id)))
      return blocked("conflicting_claim", "Another execution claim owns this task.");
    const leases = await db.select().from(environmentLeases).where(and(
      eq(environmentLeases.companyId, companyId),
      or(eq(environmentLeases.issueId, issueId), inArray(environmentLeases.heartbeatRunId, sources.map(run => run.id))),
    )).orderBy(environmentLeases.id).for("update");
    if (leases.some(lease => !lease.releasedAt || lease.cleanupStatus !== "success"))
      return blocked("environment_cleanup_required", "Every affected environment requires completed cleanup before reset.");
    const inspection = await collectExecutionResetInspection(db, companyId, issueId);
    if (inspection?.fingerprint !== board.fingerprint)
      return blocked("stale_reset_expectations", "Execution evidence changed while admitting reset.");
  }
  if (input.dryRun) return { previousRunId: previous.id, commentId, ...(retry ? { failedRunId: input.failedRunId! } : {}) };
  for (const stopped of stoppedSessions) {
    if (!stopped.retire()) return blocked("local_cleanup", "The previous provider cleanup changed. Your message is saved.");
    await appendHeartbeatRunEvent(db, {
      companyId, runId: String(stopped.evidence.runId), agentId,
      eventType: "native.stopped_conversation_verified", stream: "system", level: "info",
      message: "The old runner and provider stopped. New user input will use a fresh session; prior action outcomes remain recorded.",
      payload: stopped.evidence,
    });
  }
  const authorization = { ...(board ? { ...board, actorId, intent: "start_fresh_history_aware_turn", acknowledgeFreshHistoryAwareTurn: true } : dependency ? { ...dependency, intent: "dependency_blockers_resolved" } : { actorId, commentId }), ...(response ? { interactionId: response.source.interactionId } : {}), ...(retry ? { failedRunId: input.failedRunId } : {}),
    ...(comment ? { commentUpdatedAt: comment.updatedAt.toISOString(),
      commentBodyHash: createHash("sha256").update(comment.body).digest("hex") } : {}),
    ...(queuedInterrupt ? { queuedCommentInterruptId: input.queuedCommentInterruptId } : {}),
    ...(queuedRequest ? { queuedCommentRequestId: input.queuedCommentRequestId } : {}), runId: input.successorRunId,
    previousRunId: previous.id, recordedAt: new Date().toISOString() };
  for (const runId of cancelledStartupIds) {
    await db.update(nativeRunFinalizations).set({
      phase: "terminal_failure", failureCode: "native_startup_cancelled", nextAttemptAt: null,
      controlDeadlineAt: null, updatedAt: new Date(),
    }).where(and(eq(nativeRunFinalizations.companyId, companyId), eq(nativeRunFinalizations.runId, runId)));
    await db.update(heartbeatRuns).set({
      ...(nativeSources.some(run => run.id === runId) ? { nativePhase: "terminal_failure", nativePhaseUpdatedAt: new Date() } : {}),
      executionControlDeadlineAt: null,
    }).where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, runId)));
  }
  if (nativeSources.length) await db.update(nativeRunFinalizations).set({
    failureDetail: sql`coalesce(${nativeRunFinalizations.failureDetail}, '{}'::jsonb) || ${JSON.stringify({ replacementDenied: board ? "board_execution_reset" : dependency ? "dependency_closure_continuation" : "explicit_user_continuation" })}::jsonb`,
    updatedAt: new Date(),
  }).where(and(eq(nativeRunFinalizations.companyId, companyId), inArray(nativeRunFinalizations.runId, nativeSources.map(run => run.id))));
  for (const action of actions) {
    await db.update(issueRecoveryActions).set({
      status: "resolved", outcome: "cancelled", resolvedAt: new Date(), updatedAt: new Date(),
      nextAction: board ? "The board requested a fresh history-aware turn." : dependency ? "A verified dependency closure started a fresh history-aware turn." : "The user started a fresh conversation turn. Prior action outcomes remain recorded.",
      resolutionNote: strict ? "Verified action settlement and stopped execution; prior outcomes are retained." : "The user continued after the prior execution stopped. No action outcomes were inferred.",
      wakePolicy: null, monitorPolicy: null,
      evidence: { ...action.evidence, [board ? "boardExecutionReset" : dependency ? "dependencyClosureContinuation" : "explicitUserContinuation"]: authorization,
        ...(action.evidence.automaticRecovery ? { automaticRecovery: {
          ...(action.evidence.automaticRecovery as Record<string, unknown>), replay: board ? "board_execution_reset" : dependency ? "dependency_closure_continuation" : "explicit_user_continuation",
        } } : {}),
      },
    }).where(eq(issueRecoveryActions.id, action.id));
  }
  await persistActivity(db, { companyId, actorType: dependency ? "system" : "user", actorId: dependency ? "issue-dependencies" : actorId!,
    action: "issue.execution_recovery_settled", entityType: "issue", entityId: issueId,
    details: { continuation: board ? "board_execution_reset" : dependency ? "dependency_blockers_resolved" : retry ? "explicit_user_retry" : "explicit_user_message", ...authorization,
      recoveryActionIds: actions.map(action => action.id), previousRunIds: sources.map(run => run.id) },
  });
  return { previousRunId: previous.id, commentId, ...(retry ? { failedRunId: input.failedRunId! } : {}) };
}

/** Re-admit a bounded automatic retry without lending it its parent's receipt.
 * The caller holds the task lock and creates the successor in this transaction.
 * Only unchanged user messages are renewable; Retry/Interrupt intents keep their
 * separate one-run contracts. The scheduler still owns retry and cleanup policy.
 */
export async function admitExplicitContinuationRetry(input: {
  db: Db; companyId: string; issueId: string; agentId: string;
  parentRunId: string; successorRunId: string; now: Date;
}): Promise<{ previousRunId: string; commentId: string } | null> {
  const { db, companyId, issueId, agentId } = input;
  const [task] = await db.select().from(issues).where(and(
    eq(issues.companyId, companyId), eq(issues.id, issueId),
  )).for("update");
  const [parent] = await db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, input.parentRunId),
    eq(heartbeatRuns.agentId, agentId),
  )).for("update");
  if (!task || task.assigneeAgentId !== agentId || task.executionRunId !== input.parentRunId ||
      ["done", "cancelled"].includes(task.status) || !parent ||
      !["failed", "timed_out"].includes(parent.status) || !parent.finishedAt ||
      parent.runtimeMode !== "legacy" || parent.contextSnapshot?.issueId !== issueId ||
      (parent.nativeIssueId !== null && parent.nativeIssueId !== issueId) ||
      adapterExecutionControls.has(parent.id) ||
      await getExecutionBlocker(db, companyId, issueId)) return null;
  const context = parent.contextSnapshot;
  const explicit = context.explicitUserContinuation as Record<string, unknown> | undefined;
  if (!explicit || !z.string().guid().safeParse(explicit.previousRunId).success ||
      !z.string().guid().safeParse(explicit.commentId).success || explicit.failedRunId) return null;
  const commentId = explicit.commentId as string;
  const [comment] = await db.select().from(issueComments).where(and(
    eq(issueComments.companyId, companyId), eq(issueComments.issueId, issueId),
    eq(issueComments.id, commentId), eq(issueComments.authorType, "user"),
    isNull(issueComments.createdByRunId), isNull(issueComments.deletedAt),
  ));
  if (!comment?.authorUserId || !comment.body.trim()) return null;
  const receipts = await db.select().from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, companyId), eq(issueRecoveryActions.sourceIssueId, issueId),
    eq(issueRecoveryActions.status, "resolved"),
    sql`${issueRecoveryActions.evidence}->'explicitUserContinuation'->>'runId' = ${parent.id}`,
  ));
  const receipt = receipts.find(row => {
    const auth = row.evidence.explicitUserContinuation as Record<string, unknown> | undefined;
    return auth && auth.previousRunId === explicit.previousRunId && auth.commentId === commentId &&
      auth.actorId === comment.authorUserId && !auth.failedRunId && !auth.queuedCommentInterruptId &&
      auth.commentUpdatedAt === comment.updatedAt.toISOString() &&
      auth.commentBodyHash === createHash("sha256").update(comment.body).digest("hex");
  });
  if (!receipt) return null;
  const [superseding] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, companyId),
    or(eq(heartbeatRuns.nativeIssueId, issueId), sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issueId}`),
    ne(heartbeatRuns.id, parent.id), ne(heartbeatRuns.id, input.successorRunId),
    or(eq(heartbeatRuns.retryOfRunId, parent.id),
      // Keep PostgreSQL's timestamp precision: Date would round the parent
      // down and mistake an older run in the same millisecond for a successor.
      sql`${heartbeatRuns.createdAt} > (select source.created_at from heartbeat_runs source
        where source.company_id = ${companyId} and source.id = ${parent.id})`,
      inArray(heartbeatRuns.status, ["queued", "running", "scheduled_retry"])),
  )).limit(1);
  if (superseding) return null;
  // Reuse dispatch's complete source/actor/receipt validation on the parent.
  // It proves only the parent; the new receipt below authorizes the successor.
  try {
    await buildExecutionContinuation({ db, companyId, issueId, agentId, runId: parent.id,
      context, summary: null, exposeLowTrustRaw: false });
  } catch (error) {
    if (error instanceof Error && ["continuation_user_authorization_missing",
      "continuation_source_context_missing", "continuation_task_ownership_changed"].includes(error.message)) return null;
    throw error;
  }
  const continuation = { previousRunId: parent.id, commentId };
  await db.insert(issueRecoveryActions).values({
    companyId, sourceIssueId: issueId, kind: "active_run_watchdog",
    cause: "explicit_user_continuation_retry", fingerprint: input.successorRunId,
    status: "resolved", outcome: "retry_authorized", resolvedAt: input.now,
    nextAction: "The bounded retry has its own authorization for the unchanged user message.",
    evidence: { explicitUserContinuation: {
      ...continuation, actorId: comment.authorUserId, runId: input.successorRunId,
      commentUpdatedAt: comment.updatedAt.toISOString(),
      commentBodyHash: createHash("sha256").update(comment.body).digest("hex"),
      recordedAt: input.now.toISOString(), automaticRetry: {
        sourceRunId: parent.id, sourceAuthorizationId: receipt.id,
      },
    } },
  });
  return continuation;
}
