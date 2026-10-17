import { describe, expect, it } from "vitest";
import { summarizeWakeWaste } from "./wake-waste-metrics.js";

describe("wake waste report", () => {
  const sample = (id: string, startedAt = "2026-10-16T23:59:00Z") => ({
    id, issueId: "issue-1", agentId: "agent-1", startedAt: new Date(startedAt),
    reason: "issue_unblock_requested", system: true, outcome: null,
  });
  it("counts actual run ids once and alerts at five with a stable issue/hour key", () => {
    const four = Array.from({ length: 4 }, (_, i) => sample(String(i)));
    expect(summarizeWakeWaste(four).hourly[0]?.alertKey).toBeNull();
    const five = summarizeWakeWaste([...four, sample("4"), sample("4")]);
    expect(five.hourly[0]).toMatchObject({ wakes: 5, alertKey: "issue-1:2026-10-16T23" });
    expect(summarizeWakeWaste([...four, sample("4"), sample("5")]).hourly[0]?.alertKey)
      .toBe(five.hourly[0]?.alertKey);
  });
  it("keeps human wakes out of system counts and unknown outcomes out of no-op counts", () => {
    const result = summarizeWakeWaste([sample("1"), { ...sample("2"), system: false },
      { ...sample("3", "2026-10-17T00:00:00Z"), outcome: "restated_status" }]);
    expect(result.hourly.map(row => row.wakes)).toEqual([1, 1]);
    expect(result.daily).toEqual([
      { day: "2026-10-16", noOpRuns: 0, unknownRuns: 2 },
      { day: "2026-10-17", noOpRuns: 1, unknownRuns: 0 },
    ]);
  });
});
