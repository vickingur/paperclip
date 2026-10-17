import { describe, expect, it } from "vitest";
import { wakeBatchDelayMs, wakeBatchIsWaiting } from "./wake-coalescing.js";

describe("bounded wake batch", () => {
  it("holds replaceable fan-out for five seconds but never human or interaction input", () => {
    const input = { reason: "issue_commented", actorType: "agent", interactionId: null, manual: false };
    expect(wakeBatchDelayMs(input)).toBe(5000);
    expect(wakeBatchDelayMs({ ...input, actorType: "user" })).toBe(0);
    expect(wakeBatchDelayMs({ ...input, interactionId: "decision-1" })).toBe(0);
    expect(wakeBatchDelayMs({ ...input, manual: true })).toBe(0);
    expect(wakeBatchDelayMs({ ...input, reason: "issue_children_completed", actorType: "system" })).toBe(5000);
    expect(wakeBatchDelayMs({ ...input, reason: "approval_approved" })).toBe(0);
  });
  it("has a fixed dispatch cutoff that survives restart without sliding on new events", () => {
    const context = { wakeBatchNotBefore: "2026-10-17T00:00:05.000Z" };
    expect(wakeBatchIsWaiting(context, new Date("2026-10-17T00:00:04.999Z"))).toBe(true);
    expect(wakeBatchIsWaiting(JSON.parse(JSON.stringify(context)), new Date("2026-10-17T00:00:05Z"))).toBe(false);
    expect(wakeBatchIsWaiting({}, new Date())).toBe(false);
  });
});
