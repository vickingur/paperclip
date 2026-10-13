import { conflict } from "../errors.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRuns, type Db } from "@paperclipai/db";
import { executionResetRequestSchema, executionResetCommittedResponseSchema } from "@paperclipai/shared";

const intentSchema = executionResetRequestSchema.extend({
  companyId: z.string().guid(),
  issueId: z.string().guid(),
  principalId: z.string().min(1),
}).strict();

export type ExecutionResetIntent = z.infer<typeof intentSchema>;

/** Internal producer contract. Caller must serialize on the issue before lookup
 * and persist this identity with admission and the successor in one transaction.
 * This helper validates retry identity; it does not grant reset admission. */
export function executionResetIdentity(value: ExecutionResetIntent) {
  const intent = intentSchema.parse(value);
  const digest = (parts: unknown[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");
  return {
    scopedKey: `execution-reset:${digest([intent.companyId, intent.issueId, intent.principalId, intent.idempotencyKey])}`,
    payloadDigest: digest([intent.companyId, intent.issueId, intent.principalId,
      intent.expectedHoldingRunId, intent.expectedRecoveryActionId, intent.fingerprint,
      intent.acknowledgeFreshHistoryAwareTurn]),
  };
}

const responseSchema = executionResetCommittedResponseSchema;
export type ExecutionResetCommittedResponse = z.infer<typeof responseSchema>;

/** Retry returns the saved commit, even after successor completion. Never
 * recompute admission or construct a new response from mutable current state. */
export function replayExecutionReset(
  intent: ExecutionResetIntent,
  receipt: { scopedKey: string; payloadDigest: string; response: unknown },
): ExecutionResetCommittedResponse {
  const identity = executionResetIdentity(intent);
  if (receipt.scopedKey !== identity.scopedKey || receipt.payloadDigest !== identity.payloadDigest)
    throw conflict("execution_reset_idempotency_conflict");
  const response = responseSchema.parse(receipt.response);
  if (response.issueId !== intent.issueId || response.previousRunId !== intent.expectedHoldingRunId)
    throw conflict("execution_reset_receipt_mismatch");
  return response;
}

/** Internal retry lookup under the producer's issue lock. An existing row is
 * never treated as a fresh attempt, including malformed/incomplete commits.
 * The committed response remains authoritative after successor completion. */
export async function findCommittedExecutionReset(db: Db, intent: ExecutionResetIntent) {
  const identity = executionResetIdentity(intent);
  const rows = await db.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, intent.companyId),
    eq(agentWakeupRequests.idempotencyKey, identity.scopedKey),
  ));
  if (!rows.length) return null;
  if (rows.length !== 1) throw conflict("execution_reset_receipt_mismatch");
  const request = rows[0];
  const commit = z.object({ payloadDigest: z.string(), response: responseSchema }).strict()
    .parse(request.payload?.executionResetCommit);
  const response = replayExecutionReset(intent, { ...identity, payloadDigest: commit.payloadDigest, response: commit.response });
  const board = request.payload?.boardExecutionReset as Record<string, unknown> | undefined;
  if (request.reason !== "execution_reset" || !["coalesced", "claimed", "completed", "failed", "cancelled", "skipped"].includes(request.status) ||
      request.requestedByActorType !== "user" || request.requestedByActorId !== intent.principalId ||
      request.payload?.issueId !== intent.issueId || request.id !== response.resetId ||
      request.runId !== response.successorRunId || !board ||
      board.resetId !== response.resetId || board.actorId !== intent.principalId ||
      board.fingerprint !== intent.fingerprint || board.expectedHoldingRunId !== intent.expectedHoldingRunId ||
      board.expectedRecoveryActionId !== intent.expectedRecoveryActionId ||
      board.previousRunId !== response.previousRunId || board.acknowledgeFreshHistoryAwareTurn !== true)
    throw conflict("execution_reset_receipt_mismatch");
  const [successor] = await db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, intent.companyId), eq(heartbeatRuns.id, response.successorRunId),
    eq(heartbeatRuns.agentId, request.agentId),
  ));
  const saved = successor?.contextSnapshot?.boardExecutionReset as Record<string, unknown> | undefined;
  if (!successor || successor.wakeupRequestId !== request.id ||
      successor.contextSnapshot?.issueId !== intent.issueId || successor.contextSnapshot?.forceFreshSession !== true ||
      !saved || !["resetId", "actorId", "fingerprint", "expectedHoldingRunId", "expectedRecoveryActionId", "previousRunId",
        "acknowledgeFreshHistoryAwareTurn"].every(key => saved[key] === board[key]))
    throw conflict("execution_reset_receipt_mismatch");
  return response;
}
