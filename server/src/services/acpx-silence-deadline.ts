/** Run-scoped deadline, independent of log traffic and total execution time. */
export const ACPX_SILENCE_DEADLINE_MS = 1_200_000;
export type SilenceSnapshot = {
  lastProgressAt: number;
  silenceMs: number;
  pendingToolIds: string[];
};

export function createAcpxSilenceDeadline(input: {
  now?: () => number;
  startedAt?: number;
  /** Recheck durable status/operator decisions, then invoke commit without awaiting. */
  admit: (commit: () => SilenceSnapshot | null) => Promise<void>;
  onStop: (snapshot: SilenceSnapshot) => Promise<void>;
  onError: (error: unknown) => void;
}) {
  const now = input.now ?? Date.now;
  let lastProgressAt = input.startedAt ?? now();
  let generation = 0;
  let stopped = false;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = new Map<string, string>();
  const seen = new Map<string, string>();
  const schedule = (delay: number) => {
    if (!disposed && !stopped) {
      timer = setTimeout(() => { void check(); }, Math.max(1, delay));
      timer.unref?.();
    }
  };
  const check = async () => {
    const observed = generation;
    let admitted: SilenceSnapshot | null = null;
    try {
      if (disposed || stopped) return;
      if (now() - lastProgressAt < ACPX_SILENCE_DEADLINE_MS) return;
      await input.admit(() => {
        // Fresh output wins even if it arrived while the database read waited.
        // No asynchronous work separates this check and the local claim.
        if (disposed || stopped || generation !== observed ||
            now() - lastProgressAt < ACPX_SILENCE_DEADLINE_MS) return null;
        stopped = true;
        admitted = { lastProgressAt, silenceMs: now() - lastProgressAt,
          pendingToolIds: [...pending.keys()] };
        return admitted;
      });
    } catch (error) {
      input.onError(error);
    } finally {
      if (admitted) {
        try { await input.onStop(admitted); } catch (error) { input.onError(error); }
      }
      // Suppression and unavailable control-plane reads fail closed. Recheck at
      // a bounded cadence; never start another provider or replay a command.
      const remaining = ACPX_SILENCE_DEADLINE_MS - (now() - lastProgressAt);
      schedule(remaining > 0 ? remaining : 30_000);
    }
  };
  schedule(Math.max(1, ACPX_SILENCE_DEADLINE_MS - (now() - lastProgressAt)));
  return {
    observe(record: Record<string, unknown>) {
      if (disposed || stopped) return;
      let meaningful = record.type === "acpx.text_delta" &&
        typeof record.text === "string" && record.text.trim().length > 0;
      if (record.type === "acpx.tool_call" && typeof record.toolCallId === "string") {
        const id = record.toolCallId;
        const status = typeof record.status === "string" ? record.status : "pending";
        const signature = JSON.stringify([status, record.text ?? null]);
        const previous = seen.get(id);
        // Repeated pending/status polling is not progress. Tool text is actual
        // output; a new call or changed lifecycle status also advances the clock.
        meaningful ||= previous !== signature;
        seen.set(id, signature);
        pending.set(id, status);
        if (["completed", "failed", "cancelled"].includes(status)) pending.delete(id);
      }
      if (meaningful) { lastProgressAt = now(); generation += 1; }
    },
    dispose() { disposed = true; clearTimeout(timer); },
  };
}

/** Match the Claude adapter's default ACP selection without affecting CLI/native. */
export function usesClaudeAcpxSilenceDeadline(adapterType: string, engine: unknown, native: boolean) {
  return !native && adapterType === "claude_local" &&
    String(engine ?? "").trim().toLowerCase() !== "cli";
}
