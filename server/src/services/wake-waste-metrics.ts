export type WakeWasteSample = {
  id: string;
  issueId: string;
  agentId: string;
  startedAt: Date;
  reason: string | null;
  system: boolean;
  /** Explicit outcome only; absence is unknown, never an inferred no-op. */
  outcome: string | null;
  /** SQL may pre-aggregate distinct run IDs for one bucket. */
  count?: number;
};

/** Read-only alert identities are stable across report retries and restarts.
 * They do not write task comments or enqueue another assignee wake. */
export function summarizeWakeWaste(samples: WakeWasteSample[]) {
  const seen = new Set<string>();
  const hourly = new Map<string, { issueId: string; hour: string; wakes: number; reasons: string[]; alertKey: string | null }>();
  const daily = new Map<string, { day: string; noOpRuns: number; unknownRuns: number }>();
  for (const sample of samples) {
    if (seen.has(sample.id)) continue;
    seen.add(sample.id);
    const count = sample.count ?? 1;
    const timestamp = sample.startedAt.toISOString();
    const day = timestamp.slice(0, 10);
    const dailyRow = daily.get(day) ?? { day, noOpRuns: 0, unknownRuns: 0 };
    if (sample.outcome === "restated_status") dailyRow.noOpRuns += count;
    else if (sample.outcome !== "productive") dailyRow.unknownRuns += count;
    daily.set(day, dailyRow);
    if (!sample.system) continue;
    const hour = timestamp.slice(0, 13);
    const key = `${sample.issueId}:${hour}`;
    const row = hourly.get(key) ?? { issueId: sample.issueId, hour, wakes: 0, reasons: [], alertKey: null };
    row.wakes += count;
    if (sample.reason && !row.reasons.includes(sample.reason)) row.reasons.push(sample.reason);
    if (row.wakes >= 5) row.alertKey = key;
    hourly.set(key, row);
  }
  return {
    hourly: [...hourly.values()].sort((a, b) => a.hour.localeCompare(b.hour) || a.issueId.localeCompare(b.issueId)),
    daily: [...daily.values()].sort((a, b) => a.day.localeCompare(b.day)),
  };
}
