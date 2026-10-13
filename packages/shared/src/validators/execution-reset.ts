import { z } from "zod";

/** Company, issue and principal are supplied by the authenticated server. */
export const executionResetRequestSchema = z.object({
  idempotencyKey: z.string().min(1).max(200),
  expectedHoldingRunId: z.string().guid(),
  expectedRecoveryActionId: z.string().guid(),
  fingerprint: z.string().min(1),
  acknowledgeFreshHistoryAwareTurn: z.literal(true),
}).strict();

export const executionResetCommittedResponseSchema = z.object({
  resetId: z.string().guid(),
  issueId: z.string().guid(),
  successorRunId: z.string().guid(),
  previousRunId: z.string().guid(),
}).strict();

export type ExecutionResetRequest = z.infer<typeof executionResetRequestSchema>;
export type ExecutionResetCommittedResponse = z.infer<typeof executionResetCommittedResponseSchema>;
