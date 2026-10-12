import { describe, expect, it } from "vitest";
import { codexWindowLabel, mapCodexRpcQuota } from "./quota.js";

describe("codexWindowLabel", () => {
  it("names a window by the length the provider reports", () => {
    expect(codexWindowLabel(5 * 3600, "Weekly limit")).toBe("5h limit");
    expect(codexWindowLabel(7 * 86400, "5h limit")).toBe("Weekly limit");
    expect(codexWindowLabel(30 * 86400, "5h limit")).toBe("30d limit");
  });

  it("keeps the fallback when no length is reported", () => {
    expect(codexWindowLabel(null, "5h limit")).toBe("5h limit");
    expect(codexWindowLabel(0, "Weekly limit")).toBe("Weekly limit");
  });

  it("labels a weekly primary window from the app server as weekly", () => {
    const { windows } = mapCodexRpcQuota({
      rateLimits: { limitId: "codex", primary: { usedPercent: 23, windowDurationMins: 7 * 24 * 60, resetsAt: 1_800_000_000 } },
    } as never);
    expect(windows.map((window) => window.label)).toEqual(["Weekly limit"]);
  });
});
