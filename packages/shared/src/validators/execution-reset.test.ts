import { describe, expect, it } from "vitest";
import { executionResetRequestSchema } from "./execution-reset.js";

const request = {
  idempotencyKey: "board-reset-1",
  expectedHoldingRunId: "00000000-0000-4000-8000-000000000001",
  expectedRecoveryActionId: "00000000-0000-4000-8000-000000000002",
  fingerprint: "saved-preview-fingerprint",
  acknowledgeFreshHistoryAwareTurn: true,
};

describe("execution reset public request", () => {
  it("accepts an exact preview-bound reset request", () => {
    expect(executionResetRequestSchema.parse(request)).toEqual(request);
  });
  it.each(["companyId", "issueId", "principalId", "actorId", "forceFreshSession"])(
    "rejects caller supplied authority field %s", field => {
      expect(executionResetRequestSchema.safeParse({ ...request, [field]: "forged" }).success).toBe(false);
    });
  it.each([
    { acknowledgeFreshHistoryAwareTurn: false },
    { expectedHoldingRunId: "wrong" },
    { expectedRecoveryActionId: "wrong" },
    { fingerprint: "" },
    { idempotencyKey: "" },
    { idempotencyKey: "a".repeat(201) },
  ])("rejects missing consent or unusable retry/preview identity %j", invalid => {
    expect(executionResetRequestSchema.safeParse({ ...request, ...invalid }).success).toBe(false);
  });
});
