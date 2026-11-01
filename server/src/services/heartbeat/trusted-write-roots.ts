import { createHash } from "node:crypto";
import path from "node:path";

// Trusted extra write roots for the Codex ACP turn sandbox.
//
// The only rule source is the server deploy environment
// (`PAPERCLIP_TRUSTED_WRITE_ROOTS`, a JSON array the board controls). Agent
// config, prompts, issue text, titles and wake payloads cannot reach it. Each
// rule binds one exact path to explicitly listed issues, agents and adapters;
// there is no project-wide grant. Admission reads only the same-company DB issue
// record and the realized execution workspace, never `context.projectId`, the
// wake payload or any title/prompt text. Every absent, malformed or mismatched
// input yields no grant.

export const TRUSTED_WRITE_ROOTS_ENV = "PAPERCLIP_TRUSTED_WRITE_ROOTS";

export interface TrustedWriteRootRule {
  path: string;
  companyId: string;
  projectId: string;
  issueIds: string[];
  workModes: ["standard"];
  agentIds: string[];
  adapterTypes: string[];
}

export interface TrustedWriteRootAdmission {
  path: string;
  ruleIndex: number;
  issueId: string;
}

export interface ParsedTrustedWriteRoots {
  rules: TrustedWriteRootRule[];
  /** 12 hex chars of sha256 over the canonical JSON of the parsed rules; null when there are none. */
  hash: string | null;
  /** Set when the variable was present but rejected. The rule set is then empty. */
  error: string | null;
}

const RULE_KEYS = ["path", "companyId", "projectId", "issueIds", "workModes", "agentIds", "adapterTypes"] as const;
const ID_ARRAY_KEYS = ["issueIds", "agentIds", "adapterTypes"] as const;

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value === value.trim();
}

function parseRule(value: unknown, index: number): TrustedWriteRootRule {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`rule ${index} is not an object`);
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(RULE_KEYS as readonly string[]).includes(key)) throw new Error(`rule ${index} has unknown field "${key}"`);
  }
  for (const key of ["path", "companyId", "projectId"] as const) {
    if (!isNonEmptyString(record[key])) throw new Error(`rule ${index} field "${key}" must be a non-empty string`);
  }
  const rulePath = record.path as string;
  if (!path.posix.isAbsolute(rulePath) || path.posix.normalize(rulePath) !== rulePath || rulePath.length > 1 && rulePath.endsWith("/")) {
    throw new Error(`rule ${index} path must be absolute and normalized`);
  }
  for (const key of ID_ARRAY_KEYS) {
    const entries = record[key];
    if (!Array.isArray(entries) || entries.length === 0 || !entries.every(isNonEmptyString)) {
      throw new Error(`rule ${index} field "${key}" must be a non-empty array of non-empty strings`);
    }
  }
  const workModes = record.workModes;
  // This version admits only standard execution; planning, ask, skill_test and
  // any unknown value are schema errors, not silently ignored entries.
  if (!Array.isArray(workModes) || workModes.length === 0 || !workModes.every((mode) => mode === "standard")) {
    throw new Error(`rule ${index} field "workModes" must be ["standard"]`);
  }
  return {
    path: rulePath,
    companyId: record.companyId as string,
    projectId: record.projectId as string,
    issueIds: [...(record.issueIds as string[])],
    workModes: ["standard"],
    agentIds: [...(record.agentIds as string[])],
    adapterTypes: [...(record.adapterTypes as string[])],
  };
}

/**
 * Parse the deploy-env rule array. Absent or empty yields no rules and no error.
 * Anything else that fails the schema yields no rules (fail closed) and an error
 * the caller logs once.
 */
export function parseTrustedWriteRoots(raw: string | undefined): ParsedTrustedWriteRoots {
  if (raw === undefined || raw.trim() === "") return { rules: [], hash: null, error: null };
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) throw new Error("value is not a JSON array");
    if (value.length === 0) throw new Error("rule array is empty");
    const rules = value.map(parseRule);
    const hash = createHash("sha256").update(canonicalJson(rules)).digest("hex").slice(0, 12);
    return { rules, hash, error: null };
  } catch (error) {
    return { rules: [], hash: null, error: error instanceof Error ? error.message : String(error) };
  }
}

export interface TrustedWriteRootDbIssue {
  id: string;
  companyId: string;
  projectId: string | null;
  workMode: string | null;
  isConversation: boolean;
}

/**
 * Resolve the admitted roots for one run. Only DB-sourced values are inputs:
 * the company-scoped issue record and the realized execution workspace's
 * project. Only an exact allowed issue/agent/project/workspace/adapter/standard
 * tuple admits.
 */
export function resolveTrustedWriteRoots(input: {
  rules: readonly TrustedWriteRootRule[];
  agent: { id: string; companyId: string; adapterType: string };
  dbIssue: TrustedWriteRootDbIssue | null;
  workspaceProjectId: string | null;
}): TrustedWriteRootAdmission[] {
  const issue = input.dbIssue;
  if (!issue || issue.isConversation) return [];
  if (issue.companyId !== input.agent.companyId) return [];
  if (!issue.projectId || issue.projectId !== input.workspaceProjectId) return [];
  if (issue.workMode !== "standard") return [];
  return input.rules.flatMap((rule, ruleIndex) =>
    rule.companyId === issue.companyId &&
    rule.projectId === issue.projectId &&
    rule.issueIds.includes(issue.id) &&
    rule.workModes.includes("standard") &&
    rule.agentIds.includes(input.agent.id) &&
    rule.adapterTypes.includes(input.agent.adapterType)
      ? [{ path: rule.path, ruleIndex, issueId: issue.id }]
      : [],
  );
}

let cachedRaw: string | undefined;
let cachedParsed: ParsedTrustedWriteRoots | null = null;

/**
 * Read and parse the rule env for a run. The parse is cached per raw value, so a
 * rejected value logs its warning once per process instead of once per run.
 */
export function readTrustedWriteRootsFromEnv(
  env: NodeJS.ProcessEnv,
  warn: (message: string) => void,
): ParsedTrustedWriteRoots {
  const raw = env[TRUSTED_WRITE_ROOTS_ENV];
  if (cachedParsed && cachedRaw === raw) return cachedParsed;
  const parsed = parseTrustedWriteRoots(raw);
  cachedRaw = raw;
  cachedParsed = parsed;
  if (parsed.error) warn(`${TRUSTED_WRITE_ROOTS_ENV} rejected; no trusted write roots are granted: ${parsed.error}`);
  return parsed;
}
