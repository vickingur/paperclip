import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { executionResetIdentity, replayExecutionReset, type ExecutionResetIntent } from "./execution-reset-idempotency.js";

function fixture() {
  const intent: ExecutionResetIntent = { companyId: randomUUID(), issueId: randomUUID(), principalId: "board:user",
    idempotencyKey: "retry:1", expectedHoldingRunId: randomUUID(), expectedRecoveryActionId: randomUUID(),
    fingerprint: "current-evidence", acknowledgeFreshHistoryAwareTurn: true };
  const response = { resetId: randomUUID(), issueId: intent.issueId, successorRunId: randomUUID(), previousRunId: intent.expectedHoldingRunId };
  return { intent, response, receipt: { ...executionResetIdentity(intent), response } };
}

describe("execution reset retry contract", () => {
  it("returns exactly the saved committed successor without retaining a mutable response reference", () => {
    const { intent, response, receipt } = fixture();
    const replay = replayExecutionReset(intent, receipt);
    expect(replay).toEqual(response);
    replay.successorRunId = randomUUID();
    expect(replayExecutionReset(intent, receipt)).toEqual(response);
  });
  it.each(["companyId", "issueId", "principalId", "idempotencyKey"] as const)("isolates retries by %s", field => {
    const { intent, receipt } = fixture();
    const changed = { ...intent, [field]: field.endsWith("Id") && field !== "principalId" ? randomUUID() : "another" };
    expect(executionResetIdentity(changed).scopedKey).not.toBe(receipt.scopedKey);
    expect(() => replayExecutionReset(changed, receipt)).toThrow("idempotency_conflict");
  });
  it.each(["expectedHoldingRunId", "expectedRecoveryActionId", "fingerprint"] as const)("rejects changed %s under the same key", field => {
    const { intent, receipt } = fixture();
    const changed = { ...intent, [field]: field === "fingerprint" ? "new-evidence" : randomUUID() };
    expect(executionResetIdentity(changed).scopedKey).toBe(receipt.scopedKey);
    expect(() => replayExecutionReset(changed, receipt)).toThrow("idempotency_conflict");
  });
  it("uses structural encoding for delimiter-bearing principals and keys", () => {
    const { intent } = fixture();
    expect(executionResetIdentity({ ...intent, principalId: "a:b", idempotencyKey: "c" }).scopedKey)
      .not.toBe(executionResetIdentity({ ...intent, principalId: "a", idempotencyKey: "b:c" }).scopedKey);
  });
  it.each(["issueId", "previousRunId"] as const)("rejects a committed response with foreign %s", field => {
    const { intent, receipt } = fixture();
    expect(() => replayExecutionReset(intent, { ...receipt, response: { ...receipt.response, [field]: randomUUID() } }))
      .toThrow("receipt_mismatch");
  });
  it("rejects missing acknowledgment and incomplete commits", () => {
    const { intent, receipt } = fixture();
    expect(() => executionResetIdentity({ ...intent, acknowledgeFreshHistoryAwareTurn: false } as unknown as ExecutionResetIntent)).toThrow();
    expect(() => replayExecutionReset(intent, { ...receipt, response: { issueId: intent.issueId } })).toThrow();
  });
});
