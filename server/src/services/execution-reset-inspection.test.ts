import { describe, expect, it } from "vitest";
import { classifyResetActions, executionResetFingerprint } from "./execution-reset-inspection.js";

describe("execution reset evidence", () => {
  it("canonicalizes JSON keys and dates while binding array order and outcomes", () => {
    expect(executionResetFingerprint({ b: { z: 1, a: 2 }, a: new Date("2026-10-13") }))
      .toBe(executionResetFingerprint({ a: "2026-10-13T00:00:00.000Z", b: { a: 2, z: 1 } }));
    expect(executionResetFingerprint(["first", "second"]))
      .not.toBe(executionResetFingerprint(["second", "first"]));
    expect(executionResetFingerprint({ outcome: "completed" }))
      .not.toBe(executionResetFingerprint({ outcome: "unknown" }));
  });
  it.each([null, {}, { actions: [] }, { actions: [{ id: "original", outcome: "unknown" }] }])(
    "never infers settlement from incomplete evidence %j", value => {
      expect(classifyResetActions(value)).toMatchObject({ outcomeClassification: "unknown", evidenceIncomplete: true });
    });
  it("retains IDs from contradictory evidence and never returns action arguments", () => {
    const result = classifyResetActions({ actions: [{ id: "original", arguments: "private" },
      { id: "original" }, { id: "second" }, { id: 12 }] });
    expect(result.unknownActionIds).toEqual(["original", "second"]);
    expect(JSON.stringify(result)).not.toContain("private");
  });
});
