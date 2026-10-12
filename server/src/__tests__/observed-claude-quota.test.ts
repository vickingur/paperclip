import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readObservedClaudeQuota } from "../services/observed-claude-quota.js";

describe("readObservedClaudeQuota", () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  async function file(doc: unknown): Promise<string> {
    dir = await mkdtemp(path.join(os.tmpdir(), "observed-quota-"));
    const target = path.join(dir, "usage.json");
    await writeFile(target, JSON.stringify(doc));
    return target;
  }

  it("turns the agents' latest reading into the panel's windows", async () => {
    const now = 1_800_000_000_000;
    const target = await file({ ts: 1_799_999_000, five_hour: { used_percentage: 41.6, resets_at: 1_800_003_600 }, seven_day: { used_percentage: 23, resets_at: 1_800_500_000 } });
    expect(await readObservedClaudeQuota({ PAPERCLIP_CLAUDE_QUOTA_FILE: target }, now)).toEqual({
      capturedAt: new Date(1_799_999_000_000).toISOString(),
      windows: [
        { label: "Current session", usedPercent: 42, resetsAt: new Date(1_800_003_600_000).toISOString(), valueLabel: null, detail: null },
        { label: "Current week (all models)", usedPercent: 23, resetsAt: new Date(1_800_500_000_000).toISOString(), valueLabel: null, detail: null },
      ],
    });
  });

  it("shows no percentage for a window that has reset since the reading", async () => {
    const target = await file({ ts: 1_799_000_000, five_hour: { used_percentage: 90, resets_at: 1_799_500_000 } });
    const observed = await readObservedClaudeQuota({ PAPERCLIP_CLAUDE_QUOTA_FILE: target }, 1_800_000_000_000);
    expect(observed?.windows).toEqual([
      { label: "Current session", usedPercent: null, resetsAt: null, valueLabel: null, detail: "Reset since the last agent reading" },
    ]);
  });

  it("is absent without a file, an unreadable file or a reading", async () => {
    expect(await readObservedClaudeQuota({})).toBeNull();
    expect(await readObservedClaudeQuota({ PAPERCLIP_CLAUDE_QUOTA_FILE: "/nonexistent/usage.json" })).toBeNull();
    expect(await readObservedClaudeQuota({ PAPERCLIP_CLAUDE_QUOTA_FILE: await file({ ts: 1 }) })).toBeNull();
  });
});
