import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runAiHomeSetup } from "../services/ai-home-setup.js";

describe("runAiHomeSetup", () => {
  let home: string | undefined;
  afterEach(async () => {
    if (home) await rm(home, { recursive: true, force: true });
  });

  it("runs the operator command with the run's provider home and harness", async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "ai-home-setup-"));
    const ran = await runAiHomeSetup({
      harness: "codex_local",
      environment: { CODEX_HOME: home },
      serverEnv: { PATH: process.env.PATH, PAPERCLIP_AI_HOME_SETUP_COMMAND: 'printf "%s" "$PAPERCLIP_AI_HARNESS" > "$CODEX_HOME/seen"' },
    });
    expect(ran).toBe(true);
    expect(await readFile(path.join(home, "seen"), "utf8")).toBe("codex_local");
  });

  it("does nothing without a command", async () => {
    expect(await runAiHomeSetup({ harness: "claude_local", environment: {}, serverEnv: {} })).toBe(false);
  });

  it("logs a failing command and lets the run go on", async () => {
    const ran = await runAiHomeSetup({
      harness: "claude_local",
      environment: {},
      serverEnv: { PATH: process.env.PATH, PAPERCLIP_AI_HOME_SETUP_COMMAND: "exit 3" },
    });
    expect(ran).toBe(false);
  });
});
