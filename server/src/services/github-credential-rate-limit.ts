import { tooManyRequests } from "../errors.js";

const WINDOW_MS = 60_000;
const LIMIT = 120;

/** Process-local defense in depth; restart clears counters. No credentials retained. */
export function createGitHubCredentialRateLimit(now = Date.now) {
  const runs = new Map<string, number[]>();
  let nextSweep = 0;
  return (scope: { companyId: string; agentId: string; runId: string }) => {
    const time = now();
    if (time >= nextSweep) {
      for (const [key, timestamps] of runs) {
        if (timestamps[timestamps.length - 1]! <= time - WINDOW_MS) runs.delete(key);
      }
      nextSweep = time + WINDOW_MS;
    }
    const key = JSON.stringify([scope.companyId, scope.agentId, scope.runId]);
    const timestamps = (runs.get(key) ?? []).filter(t => t > time - WINDOW_MS);
    if (timestamps.length >= LIMIT) {
      throw tooManyRequests("GitHub credential request limit exceeded (120 per run per 60 seconds)");
    }
    timestamps.push(time);
    runs.set(key, timestamps);
  };
}

export const enforceGitHubCredentialRateLimit = createGitHubCredentialRateLimit();
