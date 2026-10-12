import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { logger } from "../middleware/logger.js";

const run = promisify(execFile);

/**
 * Runs the operator's `PAPERCLIP_AI_HOME_SETUP_COMMAND` once a run's provider
 * home is seeded, with that home's variables (`HOME`, `CODEX_HOME`,
 * `CLAUDE_CONFIG_DIR`, …) and `PAPERCLIP_AI_HARNESS` set. Lets the operator
 * install hooks the CLI must trust per path, such as a Codex `hooks.json`.
 * A failing command is logged and the run goes on. Fork patch.
 */
export async function runAiHomeSetup(input: {
  harness: string;
  environment: Record<string, string>;
  serverEnv?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<boolean> {
  const serverEnv = input.serverEnv ?? process.env;
  const command = serverEnv.PAPERCLIP_AI_HOME_SETUP_COMMAND?.trim();
  if (!command) return false;
  try {
    await run("/bin/sh", ["-c", command], {
      env: { ...serverEnv, ...input.environment, PAPERCLIP_AI_HARNESS: input.harness },
      timeout: input.timeoutMs ?? 30_000,
    });
    return true;
  } catch (error) {
    logger.warn({ err: error, harness: input.harness }, "PAPERCLIP_AI_HOME_SETUP_COMMAND failed; the run goes on without it");
    return false;
  }
}
