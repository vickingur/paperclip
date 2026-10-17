import { and, eq, inArray, or, sql } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRuns, issueThreadInteractions, type Db } from "@paperclipai/db";
import { readRunCancellation } from "./run-cancellation.js";
import { issueThreadInteractionAttentionAgentAllowed } from "./issue-thread-interaction-resolution.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const supersededDeliveryCodes = new Set([
  "issue_assignee_changed", "issue_reassigned", "lock_released_on_reassignment",
  "issue_execution_lock_changed",
]);

/** Context identifies a card; only the current company-scoped row grants attention. */
export async function readPendingInteractionWake(
  db: Db,
  companyId: string,
  issueId: string,
  context: Record<string, unknown> | null | undefined,
) {
  if (context?.wakeReason !== "interaction_pending" ||
      typeof context.interactionId !== "string" || !uuid.test(context.interactionId)) return null;
  const [card] = await db.select().from(issueThreadInteractions).where(and(
    eq(issueThreadInteractions.id, context.interactionId),
    eq(issueThreadInteractions.companyId, companyId),
    eq(issueThreadInteractions.issueId, issueId),
    eq(issueThreadInteractions.status, "pending"),
  )).limit(1);
  if (!card?.addresseeAgentId || card.addresseeUserId ||
      !issueThreadInteractionAttentionAgentAllowed({
        agentId: card.addresseeAgentId,
        interaction: card,
        governedAction: card.kind === "request_confirmation" && "toolAction" in card.payload,
      })) return null;
  return card;
}

export async function isCurrentPendingInteractionAddressee(
  db: Db, companyId: string, issueId: string, agentId: string,
  context: Record<string, unknown> | null | undefined,
) {
  return (await readPendingInteractionWake(db, companyId, issueId, context))?.addresseeAgentId === agentId;
}

/** Called under the issue lock. Reuse the receipt, once, only for automatic supersession. */
export async function retainSupersededPendingInteractionWake(
  db: Db,
  run: typeof heartbeatRuns.$inferSelect,
  issue: { id: string; status: string; hiddenAt: Date | null },
  now: Date,
) {
  if (run.status !== "cancelled" || !supersededDeliveryCodes.has(run.errorCode ?? "") ||
      !run.wakeupRequestId || issue.hiddenAt || ["done", "cancelled"].includes(issue.status)) return false;
  const cancellation = readRunCancellation(run.resultJson);
  if (cancellation && (cancellation.source === "operator" || cancellation.initiator.type === "user" ||
      cancellation.initiator.type === "agent")) return false;
  const card = await readPendingInteractionWake(db, run.companyId, issue.id, run.contextSnapshot);
  if (!card) return false;
  const [wake] = await db.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.id, run.wakeupRequestId),
    eq(agentWakeupRequests.companyId, run.companyId),
    or(eq(agentWakeupRequests.runId, run.id),
      sql`${agentWakeupRequests.payload}->>'pendingInteractionRecoveryRunId' = ${run.id}`),
  )).for("update");
  if (!wake) return false;
  if (wake.payload?.pendingInteractionRecoveryRunId === run.id) {
    return wake.status === "deferred_issue_execution";
  }
  if (wake.payload?.pendingInteractionRecoveryAgentId === card.addresseeAgentId) return false;
  const [other] = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, run.companyId),
    eq(agentWakeupRequests.agentId, card.addresseeAgentId!),
    sql`${agentWakeupRequests.id} <> ${wake.id}`,
    or(inArray(agentWakeupRequests.status, ["queued", "claimed", "deferred_issue_execution"]),
      sql`exists (select 1 from ${heartbeatRuns} where ${heartbeatRuns.id} = ${agentWakeupRequests.runId}
        and ${heartbeatRuns.companyId} = ${run.companyId}
        and ${heartbeatRuns.status} in ('queued', 'running', 'scheduled_retry'))`),
    sql`${agentWakeupRequests.payload}->>'interactionId' = ${card.id}`,
  )).limit(1);
  if (other) return false;
  await db.update(agentWakeupRequests).set({
    agentId: card.addresseeAgentId!, status: "deferred_issue_execution", runId: null,
    claimedAt: null, finishedAt: null, error: null, updatedAt: now,
    payload: {
      ...wake.payload, issueId: issue.id, interactionId: card.id, mutation: "interaction",
      pendingInteractionRecoveryRunId: run.id, pendingInteractionRecoveryAgentId: card.addresseeAgentId,
      _paperclipWakeContext: { ...run.contextSnapshot, issueId: issue.id, taskId: issue.id,
        interactionId: card.id, wakeReason: "interaction_pending" },
    },
  }).where(and(eq(agentWakeupRequests.id, wake.id), eq(agentWakeupRequests.runId, run.id)));
  return true;
}
