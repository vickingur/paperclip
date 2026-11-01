import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  parseTrustedWriteRoots,
  readTrustedWriteRootsFromEnv,
  resolveTrustedWriteRoots,
  TRUSTED_WRITE_ROOTS_ENV,
  type TrustedWriteRootDbIssue,
} from "./trusted-write-roots.js";

// Synthetic identifiers only.
const COMPANY = "11111111-1111-4111-8111-111111111111";
const OTHER_COMPANY = "22222222-2222-4222-8222-222222222222";
const PROJECT = "33333333-3333-4333-8333-333333333333";
const OTHER_PROJECT = "44444444-4444-4444-8444-444444444444";
const ISSUE = "55555555-5555-4555-8555-555555555555";
const UNRELATED_ISSUE = "66666666-6666-4666-8666-666666666666";
const AGENT = "77777777-7777-4777-8777-777777777777";
const OTHER_AGENT = "88888888-8888-4888-8888-888888888888";
const ROOT = "/paperclip/worktrees/vik-2207-fx-root";

const rule = {
  path: ROOT,
  companyId: COMPANY,
  projectId: PROJECT,
  issueIds: [ISSUE],
  workModes: ["standard"],
  agentIds: [AGENT],
  adapterTypes: ["codex_local"],
};
const { rules } = parseTrustedWriteRoots(JSON.stringify([rule]));
const agent = { id: AGENT, companyId: COMPANY, adapterType: "codex_local" };
const allowedIssue: TrustedWriteRootDbIssue = {
  id: ISSUE, companyId: COMPANY, projectId: PROJECT, workMode: "standard", isConversation: false,
};

function resolve(overrides: Partial<Parameters<typeof resolveTrustedWriteRoots>[0]> = {}) {
  return resolveTrustedWriteRoots({ rules, agent, dbIssue: allowedIssue, workspaceProjectId: PROJECT, ...overrides });
}

describe("trusted write-root rule schema", () => {
  it("parses the exact rule and hashes the canonical parsed JSON", () => {
    const parsed = parseTrustedWriteRoots(JSON.stringify([rule]));
    expect(parsed.error).toBeNull();
    expect(parsed.rules).toEqual([rule]);
    const canonical = `[{"adapterTypes":["codex_local"],"agentIds":["${AGENT}"],"companyId":"${COMPANY}","issueIds":["${ISSUE}"],"path":"${ROOT}","projectId":"${PROJECT}","workModes":["standard"]}]`;
    expect(parsed.hash).toBe(createHash("sha256").update(canonical).digest("hex").slice(0, 12));
    // Key order in the env value does not change the hash.
    const reordered = parseTrustedWriteRoots(JSON.stringify([Object.fromEntries(Object.entries(rule).reverse())]));
    expect(reordered.hash).toBe(parsed.hash);
  });

  it("treats an absent or blank variable as no rules without an error", () => {
    expect(parseTrustedWriteRoots(undefined)).toEqual({ rules: [], hash: null, error: null });
    expect(parseTrustedWriteRoots("  ")).toEqual({ rules: [], hash: null, error: null });
  });

  // §4.1(j): malformed, partial or empty-array rules, and a planning rule.
  it.each([
    ["not JSON", "{"],
    ["an object", JSON.stringify(rule)],
    ["an empty array", "[]"],
    ["a partial rule", JSON.stringify([{ path: ROOT, companyId: COMPANY }])],
    ["an empty issue list", JSON.stringify([{ ...rule, issueIds: [] }])],
    ["an empty agent list", JSON.stringify([{ ...rule, agentIds: [] }])],
    ["an empty adapter list", JSON.stringify([{ ...rule, adapterTypes: [] }])],
    ["a planning rule", JSON.stringify([{ ...rule, workModes: ["planning"] }])],
    ["a mixed mode rule", JSON.stringify([{ ...rule, workModes: ["standard", "ask"] }])],
    ["a skill_test rule", JSON.stringify([{ ...rule, workModes: ["skill_test"] }])],
    ["an unknown mode", JSON.stringify([{ ...rule, workModes: ["anything"] }])],
    ["a relative path", JSON.stringify([{ ...rule, path: "worktrees/cache" }])],
    ["an unnormalized path", JSON.stringify([{ ...rule, path: "/paperclip/worktrees/../worktrees/cache" }])],
    ["a trailing slash", JSON.stringify([{ ...rule, path: `${ROOT}/` }])],
    ["an unknown field (project-wide grant)", JSON.stringify([{ ...rule, allIssues: true }])],
    ["a non-string id", JSON.stringify([{ ...rule, issueIds: [42] }])],
    ["one good and one bad rule", JSON.stringify([rule, { ...rule, workModes: ["planning"] }])],
  ])("rejects %s with no rules", (_label, raw) => {
    const parsed = parseTrustedWriteRoots(raw);
    expect(parsed.rules).toEqual([]);
    expect(parsed.hash).toBeNull();
    expect(parsed.error).toEqual(expect.any(String));
  });

  it("logs a rejected env value once per distinct value", () => {
    const warn = vi.fn();
    const env = { [TRUSTED_WRITE_ROOTS_ENV]: JSON.stringify([{ ...rule, workModes: ["planning"] }]) };
    expect(readTrustedWriteRootsFromEnv(env, warn).rules).toEqual([]);
    expect(readTrustedWriteRootsFromEnv(env, warn).rules).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain(`${TRUSTED_WRITE_ROOTS_ENV} rejected`);
    expect(readTrustedWriteRootsFromEnv({ [TRUSTED_WRITE_ROOTS_ENV]: JSON.stringify([rule]) }, warn).rules).toEqual([rule]);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("trusted write-root admission matrix (§4.1)", () => {
  it("(a) admits only the exact allowed issue/agent/project/workspace/adapter/standard tuple", () => {
    expect(resolve()).toEqual([{ path: ROOT, ruleIndex: 0, issueId: ISSUE }]);
  });

  it("(b) denies an unrelated standard issue in the same project with the same agent", () => {
    expect(resolve({ dbIssue: { ...allowedIssue, id: UNRELATED_ISSUE } })).toEqual([]);
  });

  it("(c) denies a taskless run even when its context project equals the rule project", () => {
    // The resolver has no context input; a taskless wake has no DB issue.
    expect(resolve({ dbIssue: null, workspaceProjectId: PROJECT })).toEqual([]);
  });

  it("(d) denies a DB issue without a project", () => {
    expect(resolve({ dbIssue: { ...allowedIssue, projectId: null }, workspaceProjectId: null })).toEqual([]);
    expect(resolve({ dbIssue: { ...allowedIssue, projectId: null } })).toEqual([]);
  });

  it("(e) denies a DB project that differs from the realized workspace project (context fallback)", () => {
    expect(resolve({ workspaceProjectId: OTHER_PROJECT })).toEqual([]);
    expect(resolve({ workspaceProjectId: null })).toEqual([]);
    expect(resolve({ dbIssue: { ...allowedIssue, projectId: OTHER_PROJECT }, workspaceProjectId: OTHER_PROJECT })).toEqual([]);
  });

  it("(f) denies an issue whose company differs from the agent's", () => {
    // The company-scoped query returns null for a foreign issue ID; a row
    // carrying another company is denied as defence in depth.
    expect(resolve({ dbIssue: null })).toEqual([]);
    expect(resolve({ dbIssue: { ...allowedIssue, companyId: OTHER_COMPANY } })).toEqual([]);
    expect(resolve({ agent: { ...agent, companyId: OTHER_COMPANY } })).toEqual([]);
  });

  it("(h) denies planning, ask, skill_test, null and unknown modes", () => {
    for (const workMode of ["planning", "ask", "skill_test", null, "", "Standard", "unknown"]) {
      expect(resolve({ dbIssue: { ...allowedIssue, workMode } })).toEqual([]);
    }
  });

  it("(i) denies a chat-conversation issue", () => {
    expect(resolve({ dbIssue: { ...allowedIssue, isConversation: true } })).toEqual([]);
  });

  it("denies another agent or another adapter type", () => {
    expect(resolve({ agent: { ...agent, id: OTHER_AGENT } })).toEqual([]);
    expect(resolve({ agent: { ...agent, adapterType: "claude_local" } })).toEqual([]);
  });

  it("(j) grants nothing when the rules were rejected", () => {
    const rejected = parseTrustedWriteRoots(JSON.stringify([{ ...rule, workModes: ["planning"] }]));
    expect(resolveTrustedWriteRoots({ rules: rejected.rules, agent, dbIssue: allowedIssue, workspaceProjectId: PROJECT })).toEqual([]);
  });

  it("returns one admission per matching rule with its index", () => {
    const two = parseTrustedWriteRoots(JSON.stringify([
      { ...rule, issueIds: [UNRELATED_ISSUE] },
      rule,
    ]));
    expect(resolveTrustedWriteRoots({ rules: two.rules, agent, dbIssue: allowedIssue, workspaceProjectId: PROJECT }))
      .toEqual([{ path: ROOT, ruleIndex: 1, issueId: ISSUE }]);
  });
});
