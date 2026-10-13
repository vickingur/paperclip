// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ExecutionResetEntry, ExecutionResetProvider } from "./ExecutionResetDialog";
import { issuesApi } from "@/api/issues";
import { ApiError } from "@/api/client";
vi.mock("@/api/issues", () => ({ issuesApi: { inspectExecutionReset: vi.fn(), resetExecution: vi.fn() } }));
vi.mock("@/lib/router", () => ({ Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a> }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const fixture = { schema: "paperclip.execution-reset-inspection.v1" as const, issueId: "00000000-0000-4000-8000-000000000001", fingerprint: "fingerprint-test", continuationMode: "fresh_history_aware" as const, validation: "required_at_reset" as const, holds: [{ recoveryActionId: "00000000-0000-4000-8000-000000000002", holdingRunId: "00000000-0000-4000-8000-000000000003", cause: "synthetic", runStatus: "failed", sourceAvailable: true, outcomeClassification: "settled" as "settled" | "unknown", unknownActionIds: [] as string[], actionCount: 1 as number | null, evidenceIncomplete: false }] };
const onQueued = vi.fn();
let root: Root;
let host: HTMLDivElement;
beforeEach(() => { vi.resetAllMocks(); vi.mocked(issuesApi.inspectExecutionReset).mockResolvedValue(structuredClone(fixture)); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(() => root.unmount()); host.remove(); });
async function render(allowed = true, pauseReason: string | null = null) { await act(() => root.render(<ExecutionResetProvider value={{ issueId: fixture.issueId, agentId: "agent", allowed, pauseReason, onQueued }}><ExecutionResetEntry /></ExecutionResetProvider>)); }
function button(label: string) { return [...document.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === label)!; }
async function click(label: string) { await act(async () => button(label).click()); }
async function ready() { await render(); await click("Inspect reset…"); await act(async () => (document.querySelector('[role="checkbox"]') as HTMLButtonElement).click()); }
it("hides access and fetches lazily", async () => { await render(false); expect(button("Inspect reset…")).toBeUndefined(); expect(issuesApi.inspectExecutionReset).not.toHaveBeenCalled(); await render(); expect(issuesApi.inspectExecutionReset).not.toHaveBeenCalled(); await click("Inspect reset…"); expect(issuesApi.inspectExecutionReset).toHaveBeenCalledTimes(1); expect(button("Reset execution").disabled).toBe(true); });
it("blocks every hold when an outcome is unknown and preserves original action IDs", async () => { const data = structuredClone(fixture); data.holds[0].outcomeClassification = "unknown"; data.holds[0].actionCount = null; data.holds[0].unknownActionIds = Array.from({ length: 12 }, (_, i) => `action-${i}`); vi.mocked(issuesApi.inspectExecutionReset).mockResolvedValue(data); await render(); await click("Inspect reset…"); expect(button("Reset execution").disabled).toBe(true); await click("Show all 12"); expect(document.body.textContent).toContain("action-11"); expect(document.body.textContent).toContain("Effects can't be ruled out"); expect(document.body.textContent).not.toMatch(/safe|verified|no effects/i); });
it("uses the exact immutable request on uncertain retries and guards double submission", async () => { let reject!: (error: Error) => void; vi.mocked(issuesApi.resetExecution).mockImplementationOnce(() => new Promise((_, r) => { reject = r; })).mockResolvedValueOnce({ resetId: "reset", issueId: fixture.issueId, successorRunId: "successor", previousRunId: "previous" }); await ready(); await click("Reset execution"); expect(button("Resetting…").disabled).toBe(true); expect(issuesApi.resetExecution).toHaveBeenCalledTimes(1); await act(async () => reject(new Error("network"))); await click("Retry same request"); const calls = vi.mocked(issuesApi.resetExecution).mock.calls; expect(calls[1][1]).toEqual(calls[0][1]); expect(calls[0][1]).toEqual({ idempotencyKey: expect.stringMatching(/^board-reset:/), expectedHoldingRunId: fixture.holds[0].holdingRunId, expectedRecoveryActionId: fixture.holds[0].recoveryActionId, fingerprint: fixture.fingerprint, acknowledgeFreshHistoryAwareTurn: true }); expect(document.body.textContent).toContain("Reset queued"); expect(document.body.textContent).not.toMatch(/running|started|complete/i); expect(document.activeElement).toBe(button("Done")); });
it("requires reinspection after a 409", async () => { vi.mocked(issuesApi.resetExecution).mockRejectedValue(new ApiError("execution_reset_admission_rejected", 409, {})); await ready(); await click("Reset execution"); expect(document.body.textContent).toContain("Reset wasn't admitted"); await click("Inspect again"); expect(issuesApi.inspectExecutionReset).toHaveBeenCalledTimes(2); expect(button("Reset execution").disabled).toBe(true); });
it("blocks pause and reveals no private-task details on 404", async () => { await render(true, "The task is paused. Resume it before resetting."); await click("Inspect reset…"); expect(button("Reset execution").disabled).toBe(true); await click("Cancel"); vi.mocked(issuesApi.inspectExecutionReset).mockRejectedValue(new ApiError("private", 404, {})); await click("Inspect reset…"); expect(document.body.textContent).toContain("This task isn't available"); expect(button("Reset execution")).toBeUndefined(); });
it("empty holds have only a close action", async () => { vi.mocked(issuesApi.inspectExecutionReset).mockResolvedValue({ ...fixture, holds: [] }); await render(); await click("Inspect reset…"); expect(button("Close")).toBeDefined(); expect(document.querySelector('[role="checkbox"]')).toBeNull(); });

it.each([403, 404])("clears inspected evidence after POST access denial %s", async status => {
  vi.mocked(issuesApi.resetExecution).mockRejectedValue(new ApiError("denied", status, {}));
  await ready(); await click("Reset execution");
  expect(document.body.textContent).not.toContain(fixture.holds[0].recoveryActionId);
  expect(button("Close")).toBeDefined(); expect(button("Reset execution")).toBeUndefined();
});
it.each([400, 409, 422])("requires fresh evidence after deterministic rejection %s", async status => {
  vi.mocked(issuesApi.resetExecution).mockRejectedValueOnce(new ApiError("synthetic_rejection", status, {}));
  await ready(); await click("Reset execution");
  expect(document.activeElement).toBe(button("Inspect again"));
  await click("Inspect again");
  expect(button("Reset execution").disabled).toBe(true);
  await act(async () => (document.querySelector('[role="checkbox"]') as HTMLButtonElement).click());
  vi.mocked(issuesApi.resetExecution).mockRejectedValueOnce(new Error("network"));
  await click("Reset execution");
  const calls = vi.mocked(issuesApi.resetExecution).mock.calls;
  expect(calls[1][1].idempotencyKey).not.toBe(calls[0][1].idempotencyKey);
});
it.each([500, 502, 503])("keeps identical payload after uncertain HTTP %s", async status => {
  vi.mocked(issuesApi.resetExecution).mockRejectedValue(new ApiError("uncertain", status, {}));
  await ready(); await click("Reset execution"); await click("Retry same request");
  const calls = vi.mocked(issuesApi.resetExecution).mock.calls;
  expect(calls[1][1]).toBe(calls[0][1]); expect(Object.isFrozen(calls[0][1])).toBe(true);
});
it("refreshes queries only after the queued result is dismissed", async () => {
  vi.mocked(issuesApi.resetExecution).mockResolvedValue({ resetId: "reset", issueId: fixture.issueId, successorRunId: "successor", previousRunId: "previous" });
  await ready(); await click("Reset execution"); expect(onQueued).not.toHaveBeenCalled();
  await click("Done"); expect(onQueued).toHaveBeenCalledTimes(1);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});
it("confirms uncertain closure and never submits while cancelling", async () => {
  vi.mocked(issuesApi.resetExecution).mockRejectedValue(new Error("network"));
  await ready(); await click("Reset execution"); await click("Cancel");
  expect(button("Close anyway")).toBeDefined(); await click("Keep open");
  expect(button("Close anyway")).toBeUndefined(); await click("Cancel"); await click("Close anyway");
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(issuesApi.resetExecution).toHaveBeenCalledTimes(1); expect(onQueued).not.toHaveBeenCalled();
});
it("focuses the heading on open and restores trigger focus on Escape", async () => {
  await render(); const trigger = button("Inspect reset…"); await click("Inspect reset…");
  expect(document.activeElement?.textContent).toBe("Execution reset");
  await act(async () => { document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(document.activeElement).toBe(trigger);
});
it("retries failed inspection without submitting", async () => {
  vi.mocked(issuesApi.inspectExecutionReset).mockRejectedValueOnce(new Error("network"));
  await render(); await click("Inspect reset…"); expect(document.activeElement).toBe(button("Try again"));
  await click("Try again"); expect(button("Reset execution").disabled).toBe(true);
  expect(issuesApi.resetExecution).not.toHaveBeenCalled();
});
it.each([
  ["execution_reset_source_unavailable", "This task is closed"],
  ["execution_reset_source_changed", "assignee or project changed"],
  ["execution_reset_company_unavailable", "company isn't active"],
  ["execution_reset_agent_unavailable", "agent is unavailable"],
  ["execution_reset_worktree_execution_cutoff", "workspace execution cutoff"],
  ["execution_reset_wake_on_demand_disabled", "doesn't accept on-demand runs"],
  ["execution_reset_idempotency_conflict", "doesn't match the one already saved"],
  ["execution_reset_receipt_mismatch", "doesn't match the one already saved"],
])("explains admission conflict %s without retrying old evidence", async (code, copy) => {
  vi.mocked(issuesApi.resetExecution).mockRejectedValue(new ApiError(code, 409, {}));
  await ready(); await click("Reset execution"); expect(document.body.textContent).toContain(copy);
  expect(button("Retry same request")).toBeUndefined();
  expect(document.querySelector<HTMLInputElement>('input[type="radio"]')?.disabled).toBe(true);
});
it("requires explicit selection with multiple holds and resets acknowledgment on selection changes", async () => {
  const data = structuredClone(fixture);
  data.holds.push({ ...data.holds[0], recoveryActionId: "another-recovery", holdingRunId: "another-run" });
  vi.mocked(issuesApi.inspectExecutionReset).mockResolvedValue(data);
  await render(); await click("Inspect reset…");
  const radios = [...document.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
  expect(radios.every(r => !r.checked)).toBe(true);
  await act(async () => radios[0].click());
  await act(async () => (document.querySelector('[role="checkbox"]') as HTMLButtonElement).click());
  expect(button("Reset execution").disabled).toBe(false);
  await act(async () => radios[1].click()); expect(button("Reset execution").disabled).toBe(true);
});
it("keeps an in-flight reset open on Escape", async () => {
  let resolve!: (value: { resetId: string; issueId: string; successorRunId: string; previousRunId: string }) => void;
  vi.mocked(issuesApi.resetExecution).mockImplementation(() => new Promise(r => { resolve = r; }));
  await ready(); await click("Reset execution");
  await act(async () => { document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  expect(button("Cancel").disabled).toBe(true);
  await act(async () => resolve({ resetId: "reset", issueId: fixture.issueId, successorRunId: "successor", previousRunId: "previous" }));
});
it("ignores an old inspection response after close and reopen", async () => {
  let resolve!: (value: typeof fixture) => void;
  vi.mocked(issuesApi.inspectExecutionReset).mockImplementationOnce(() => new Promise(r => { resolve = r; })).mockResolvedValueOnce({ ...fixture, holds: [] });
  await render(); await click("Inspect reset…"); await click("Cancel"); await click("Inspect reset…");
  await act(async () => resolve(structuredClone(fixture)));
  expect(document.body.textContent).toContain("No execution hold.");
  expect(document.body.textContent).not.toContain(fixture.holds[0].recoveryActionId);
});
