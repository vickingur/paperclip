import { readFile } from "node:fs/promises";
import type { QuotaWindow } from "@paperclipai/shared";

const WINDOWS = [
  ["five_hour", "Current session"],
  ["seven_day", "Current week (all models)"],
] as const;

/**
 * Claude Code hands its hooks the subscription's rate-limit windows on every
 * turn, and an operator hook such as usage-guard keeps the latest in a file
 * (`{ ts, five_hour: { used_percentage, resets_at }, seven_day: … }`, epoch
 * seconds). `PAPERCLIP_CLAUDE_QUOTA_FILE` names it. The quota panel falls back
 * to it when the connected account's token cannot read the usage endpoint, as
 * a `claude setup-token` token cannot. A window whose reset has passed shows
 * no percentage. Fork patch.
 */
export async function readObservedClaudeQuota(
  env: NodeJS.ProcessEnv = process.env,
  now: number = Date.now(),
): Promise<{ windows: QuotaWindow[]; capturedAt: string } | null> {
  const file = env.PAPERCLIP_CLAUDE_QUOTA_FILE?.trim();
  if (!file) return null;
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
  if (typeof doc?.ts !== "number") return null;
  const windows = WINDOWS.flatMap(([key, label]): QuotaWindow[] => {
    const reading = doc[key] as { used_percentage?: unknown; resets_at?: unknown } | undefined;
    if (typeof reading?.used_percentage !== "number" || typeof reading.resets_at !== "number") return [];
    const resetsAt = reading.resets_at * 1000;
    if (resetsAt <= now) {
      return [{ label, usedPercent: null, resetsAt: null, valueLabel: null, detail: "Reset since the last agent reading" }];
    }
    return [{ label, usedPercent: Math.round(reading.used_percentage), resetsAt: new Date(resetsAt).toISOString(), valueLabel: null, detail: null }];
  });
  return windows.length > 0 ? { windows, capturedAt: new Date(doc.ts * 1000).toISOString() } : null;
}
