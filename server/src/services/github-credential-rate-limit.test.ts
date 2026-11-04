import { expect, it } from "vitest";
import { createGitHubCredentialRateLimit } from "./github-credential-rate-limit.js";

const scope = { companyId: "company", agentId: "agent", runId: "run" };
it("admits 120 requests, rejects excess without extending the sliding window", () => {
  let now = 0;
  const admit = createGitHubCredentialRateLimit(() => now);
  for (let i = 0; i < 120; i++) admit(scope);
  expect(() => admit(scope)).toThrow(expect.objectContaining({ status: 429 }));
  now = 59_999;
  expect(() => admit(scope)).toThrow("120 per run");
  now = 60_000;
  expect(() => admit(scope)).not.toThrow();
});
it("isolates runs, agents and companies and expires inactive counters", () => {
  let now = 0;
  const admit = createGitHubCredentialRateLimit(() => now);
  for (let i = 0; i < 120; i++) admit(scope);
  for (const other of [{ runId: "other" }, { agentId: "other" }, { companyId: "other" }]) {
    expect(() => admit({ ...scope, ...other })).not.toThrow();
  }
  now = 120_000;
  for (let i = 0; i < 120; i++) admit(scope);
  expect(() => admit(scope)).toThrow(expect.objectContaining({ status: 429 }));
});
it("does not reset the budget at a minute boundary", () => {
  let now = 59_999;
  const admit = createGitHubCredentialRateLimit(() => now);
  for (let i = 0; i < 120; i++) admit(scope);
  now = 60_000;
  expect(() => admit(scope)).toThrow("120 per run");
});
