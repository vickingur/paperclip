import { afterEach, describe, expect, it, vi } from "vitest";
import { createAcpxSilenceDeadline, usesClaudeAcpxSilenceDeadline } from "./acpx-silence-deadline.js";

afterEach(() => vi.useRealTimers());
function setup(admit?: Parameters<typeof createAcpxSilenceDeadline>[0]["admit"]) {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const onStop = vi.fn(async () => {});
  const onError = vi.fn();
  const deadline = createAcpxSilenceDeadline({ admit: admit ?? (async commit => { commit(); }), onStop, onError });
  return { ...deadline, onStop, onError };
}
describe("Claude ACPX silence deadline", () => {
  it("covers a pending pre-tool hook at exactly 20 minutes, once", async () => {
    const run = setup();
    run.observe({ type: "acpx.tool_call", toolCallId: "hook", status: "pending" });
    await vi.advanceTimersByTimeAsync(1_199_000); expect(run.onStop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(run.onStop).toHaveBeenCalledWith({ lastProgressAt: 0, silenceMs: 1_200_000, pendingToolIds: ["hook"] });
    await vi.advanceTimersByTimeAsync(1_200_000); expect(run.onStop).toHaveBeenCalledTimes(1);
  });
  it("usage and repeated pending notifications do not mask silence", async () => {
    const run = setup();
    run.observe({ type: "acpx.tool_call", toolCallId: "hook", status: "pending" });
    await vi.advanceTimersByTimeAsync(600_000);
    run.observe({ type: "acpx.status", tag: "usage_update", text: "usage" });
    run.observe({ type: "acpx.tool_call", toolCallId: "hook", status: "pending" });
    await vi.advanceTimersByTimeAsync(600_000); expect(run.onStop).toHaveBeenCalledTimes(1);
  });
  it("meaningful output resets the clock and completed tools leave the inventory", async () => {
    const run = setup();
    run.observe({ type: "acpx.tool_call", toolCallId: "tool", status: "pending" });
    await vi.advanceTimersByTimeAsync(600_000);
    run.observe({ type: "acpx.tool_call", toolCallId: "tool", status: "completed" });
    await vi.advanceTimersByTimeAsync(599_999); expect(run.onStop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(600_001);
    expect(run.onStop).toHaveBeenCalledWith({ lastProgressAt: 600_000, silenceMs: 1_200_000, pendingToolIds: [] });
  });
  it("fresh output wins a delayed admission race", async () => {
    let commit!: () => unknown;
    let release!: () => void;
    const run = setup(async callback => { commit = callback; await new Promise<void>(resolve => { release = resolve; }); });
    await vi.advanceTimersByTimeAsync(1_200_000);
    run.observe({ type: "acpx.text_delta", text: "new output" });
    expect(commit()).toBeNull(); release(); await vi.advanceTimersByTimeAsync(0);
    expect(run.onStop).not.toHaveBeenCalled(); run.dispose();
  });
  it("operator suppression holds the stop until admission is allowed", async () => {
    let suppressed = true;
    const run = setup(async commit => { if (!suppressed) commit(); });
    await vi.advanceTimersByTimeAsync(1_200_000); expect(run.onStop).not.toHaveBeenCalled();
    suppressed = false; await vi.advanceTimersByTimeAsync(30_000); expect(run.onStop).toHaveBeenCalledTimes(1);
  });
  it("settlement disposes the deadline and prevents a delayed admission", async () => {
    const run = setup(); run.dispose();
    await vi.advanceTimersByTimeAsync(2_400_000); expect(run.onStop).not.toHaveBeenCalled();
  });
});

it("leaves other providers, native runs and explicit Claude CLI unchanged", () => {
  expect(usesClaudeAcpxSilenceDeadline("claude_local", undefined, false)).toBe(true);
  expect(usesClaudeAcpxSilenceDeadline("claude_local", "ACP", false)).toBe(true);
  expect(usesClaudeAcpxSilenceDeadline("claude_local", " cli ", false)).toBe(false);
  expect(usesClaudeAcpxSilenceDeadline("codex_local", "acp", false)).toBe(false);
  expect(usesClaudeAcpxSilenceDeadline("claude_local", "acp", true)).toBe(false);
});
it("does not spin while suppression stays active", async () => {
  const admit = vi.fn(async () => {});
  const run = setup(admit);
  await vi.advanceTimersByTimeAsync(1_260_000);
  expect(admit).toHaveBeenCalledTimes(3); run.dispose();
});
it("failed admission reads defer cancellation and emit diagnostics", async () => {
  const run = setup(async () => { throw new Error("database unavailable"); });
  await vi.advanceTimersByTimeAsync(1_200_000);
  expect(run.onStop).not.toHaveBeenCalled(); expect(run.onError).toHaveBeenCalledTimes(1);
  run.dispose();
});
it("a synthetic pending tool settles on scoped abort without replay", async () => {
  const controller = new AbortController();
  const toolStopped = vi.fn();
  controller.signal.addEventListener("abort", toolStopped, { once: true });
  const run = setup(async commit => { if (commit()) controller.abort(); });
  run.observe({ type: "acpx.tool_call", toolCallId: "synthetic", status: "pending" });
  await vi.advanceTimersByTimeAsync(1_200_000);
  expect(toolStopped).toHaveBeenCalledTimes(1);
  expect(run.onStop).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1_200_000); expect(toolStopped).toHaveBeenCalledTimes(1);
});

it("repeated completed notifications do not keep a run alive", async () => {
  const run = setup();
  run.observe({ type: "acpx.tool_call", toolCallId: "done", status: "completed" });
  await vi.advanceTimersByTimeAsync(600_000);
  run.observe({ type: "acpx.tool_call", toolCallId: "done", status: "completed" });
  await vi.advanceTimersByTimeAsync(600_000); expect(run.onStop).toHaveBeenCalledTimes(1);
});
it("still performs bounded stop cleanup if an audit write fails after the stop claim", async () => {
  const run = setup(async commit => { commit(); throw new Error("commit lost"); });
  await vi.advanceTimersByTimeAsync(1_200_000);
  expect(run.onError).toHaveBeenCalledTimes(1); expect(run.onStop).toHaveBeenCalledTimes(1);
});

it("waits for the durable marker before abort can trigger immediate completion", async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  let finishCommit!: () => void;
  let marker: { recovery: string } | undefined;
  let completionSnapshot: typeof marker;
  const controller = new AbortController();
  controller.signal.addEventListener("abort", () => { completionSnapshot = marker; });
  const onStop = vi.fn(async () => { controller.abort(); });
  const deadline = createAcpxSilenceDeadline({
    admit: async claim => {
      if (!claim()) return;
      await new Promise<void>(resolve => { finishCommit = resolve; });
      marker = { recovery: "explicit_operator_continue_required" };
    },
    onStop, onError: error => { throw error; },
  });
  await vi.advanceTimersByTimeAsync(1_200_000);
  expect(controller.signal.aborted).toBe(false);
  expect(onStop).not.toHaveBeenCalled();
  deadline.observe({ type: "acpx.text_delta", text: "late output after claim" });
  finishCommit(); await vi.advanceTimersByTimeAsync(0);
  expect(completionSnapshot).toEqual({ recovery: "explicit_operator_continue_required" });
  expect(onStop).toHaveBeenCalledTimes(1);
  deadline.dispose();
});

it("starts a fresh deadline when armed after slow workspace preparation", async () => {
  vi.useFakeTimers(); vi.setSystemTime(1_800_000);
  const onStop = vi.fn(async () => {});
  const deadline = createAcpxSilenceDeadline({
    admit: async claim => { claim(); }, onStop, onError: vi.fn(),
  });
  await vi.advanceTimersByTimeAsync(1_199_999);
  expect(onStop).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(onStop).toHaveBeenCalledTimes(1);
  deadline.dispose();
});
