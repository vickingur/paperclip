import { describe, expect, it } from "vitest";
import { createExecutionActionInventory, hasSettledExecutionActions } from "./execution-action-inventory.js";

const ended = { dispatchAttempted: true, streamCompleted: true, turnCompleted: false };

describe("durable execution action evidence", () => {
  it("preserves dispatch IDs and completed effects across sparse updates without content", () => {
    const ledger = createExecutionActionInventory();
    ledger.observe({ toolCallId: "effect-1", kind: "execute", status: "in_progress" });
    ledger.observe({ toolCallId: "effect-1", status: "completed", tag: "tool_call_update" });
    const evidence = ledger.snapshot(ended);
    expect(evidence.actions).toEqual([{ id: "effect-1", kind: "execute", status: "completed", outcome: "completed" }]);
    expect(hasSettledExecutionActions(JSON.parse(JSON.stringify(evidence)))).toBe(true);
  });

  it.each(["pending", "in_progress", "failed", "cancelled"])("keeps %s effects unknown", status => {
    const ledger = createExecutionActionInventory();
    ledger.observe({ toolCallId: "effect-1", kind: "edit", status });
    expect(ledger.snapshot(ended).actions[0]?.outcome).toBe("unknown");
    expect(hasSettledExecutionActions(ledger.snapshot(ended))).toBe(false);
  });

  it.each([
    [{ toolCallId: "id", kind: "execute", status: "completed", tag: "tool_call_update" }],
    [{ kind: "read", status: "completed" }],
    [{ toolCallId: "id", status: "completed" }],
    [{ toolCallId: "id", kind: "invented", status: "completed" }],
    [{ toolCallId: "id", kind: "edit", status: "completed" }, { toolCallId: "id", kind: "read" }],
    [{ toolCallId: "id", kind: "execute", status: "completed" }, { toolCallId: "id", status: "in_progress" }],
  ].map(events => ({ events })))("rejects incomplete or contradictory event sequence %#", ({ events }) => {
    const ledger = createExecutionActionInventory();
    for (const event of events) ledger.observe(event);
    expect(hasSettledExecutionActions(ledger.snapshot(ended))).toBe(false);
  });

  it("requires affirmative no-action proof rather than a silent interrupted stream", () => {
    const ledger = createExecutionActionInventory();
    expect(hasSettledExecutionActions(ledger.snapshot(ended))).toBe(false);
    expect(hasSettledExecutionActions(ledger.snapshot({ ...ended, turnCompleted: true }))).toBe(true);
    expect(hasSettledExecutionActions(ledger.snapshot({ ...ended, dispatchAttempted: false, streamCompleted: false }))).toBe(true);
    expect(hasSettledExecutionActions(ledger.snapshot({ ...ended, streamCompleted: false, turnCompleted: true }))).toBe(false);
  });

  it("does not certify completed actions after lost or flattened receipts", () => {
    const ledger = createExecutionActionInventory();
    ledger.observe({ toolCallId: "effect-1", kind: "execute", status: "completed" });
    expect(hasSettledExecutionActions(ledger.snapshot({ ...ended, streamCompleted: false }))).toBe(false);
    ledger.invalidate();
    expect(hasSettledExecutionActions(ledger.snapshot(ended))).toBe(false);
  });

  it("rejects malformed, duplicate and legacy summary evidence", () => {
    const ledger = createExecutionActionInventory();
    ledger.observe({ toolCallId: "effect-1", kind: "execute", status: "completed" });
    const evidence = ledger.snapshot(ended);
    for (const value of [null, {}, { actionOutcomes: "settled" }, { ...evidence, complete: "true" },
      { ...evidence, actions: [null] }, { ...evidence, actions: [evidence.actions[0], evidence.actions[0]] },
      { ...evidence, actions: [], noActionsConfirmed: false }, { ...evidence, dispatch: "not_attempted" }]) {
      expect(hasSettledExecutionActions(value)).toBe(false);
    }
  });
});
