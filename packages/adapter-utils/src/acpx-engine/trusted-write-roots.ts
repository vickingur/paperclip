// Validation of server-admitted trusted write roots for the Codex ACP turn
// sandbox.
//
// The server resolves admissions from its deploy env and the same-company DB
// issue (see `server/src/services/heartbeat/trusted-write-roots.ts`) and places
// them on the server-built `context.paperclipWorkspace`. The engine accepts a
// root only when it is canonical, a real directory with no symlinked
// component, owned by root or the server uid with no group/world write bit on
// it or any ancestor, free of `.git`/`.codex`/`.agents`, and not replaceable
// from the run's own sandbox namespace (the parent-entry predicate below). Any
// failure drops that root. The `{dev, ino}` recorded here is re-checked at the
// launch boundary and, inside codex-acp, before every turn.

import { constants as fsConstants, promises as fsPromises } from "node:fs";
import type { Stats } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TrustedWriteRootIdentity } from "./run-contracts.js";

export const CODEX_ACP_TRUSTED_WRITE_ROOTS_ENV = "PAPERCLIP_CODEX_ACP_TRUSTED_WRITE_ROOTS";

export interface TrustedWriteRootAdmissionRecord {
  readonly path: string;
  readonly ruleIndex: number;
  readonly issueId: string;
}

export interface TrustedWriteRootRejection {
  readonly path: string;
  readonly reason: string;
}

export interface TrustedWriteRootValidation {
  readonly roots: TrustedWriteRootIdentity[];
  readonly rejected: TrustedWriteRootRejection[];
}

/** Filesystem seam. Tests inject it; production uses `node:fs/promises`. */
export interface TrustedWriteRootFs {
  lstat(p: string): Promise<Pick<Stats, "dev" | "ino" | "uid" | "mode" | "isDirectory" | "isSymbolicLink">>;
  realpath(p: string): Promise<string>;
  /**
   * Resolves when the entry exists (without following a final symlink). Rejects
   * with `code: "ENOENT"` only when it is confirmed absent; any other rejection
   * fails validation.
   */
  lexists(p: string): Promise<void>;
}

export const defaultTrustedWriteRootFs: TrustedWriteRootFs = {
  lstat: (p) => fsPromises.lstat(p),
  realpath: (p) => fsPromises.realpath(p),
  lexists: async (p) => {
    await fsPromises.lstat(p);
  },
};

export interface TrustedWriteRootValidationOptions {
  /**
   * The run's other writable roots: cwd, `/tmp`, `$TMPDIR`, the agent home, any
   * realized temporary workspace, and every writable root of the turn policy
   * before the grant. Each is canonicalized before the predicate runs.
   */
  readonly runWritableRoots: readonly string[];
  /** The uid that may own a root or ancestor besides 0. Defaults to this process. */
  readonly serverUid?: number;
  readonly fs?: TrustedWriteRootFs;
}

const FORBIDDEN_ROOTS = new Set(["/", "/paperclip", "/paperclip/worktrees"]);
const FORBIDDEN_ENTRIES = [".git", ".codex", ".agents"];

/**
 * The run's other writable roots for the parent-entry predicate: the given
 * workspace paths, `/tmp`, every temp-dir variable of the launch env and the
 * server, and any `sandbox_workspace_write.writable_roots` in `CODEX_CONFIG`
 * (writable in the turn policy before the grant). Extra entries only make the
 * predicate stricter.
 */
export function collectRunWritableRoots(input: {
  paths: readonly string[];
  env: Record<string, string | undefined>;
  hostEnv?: Record<string, string | undefined>;
}): string[] {
  const hostEnv = input.hostEnv ?? process.env;
  const out = new Set<string>(["/tmp", os.tmpdir()]);
  for (const value of [
    ...input.paths,
    input.env.TMPDIR, input.env.TEMP, input.env.TMP,
    hostEnv.TMPDIR, hostEnv.TEMP, hostEnv.TMP,
  ]) {
    if (typeof value === "string" && path.isAbsolute(value)) out.add(path.resolve(value));
  }
  try {
    const config: unknown = input.env.CODEX_CONFIG ? JSON.parse(input.env.CODEX_CONFIG) : null;
    const record = config && typeof config === "object" ? (config as Record<string, unknown>) : {};
    const section = record.sandbox_workspace_write;
    const nested = section && typeof section === "object" ? (section as Record<string, unknown>).writable_roots : undefined;
    for (const value of [record["sandbox_workspace_write.writable_roots"], nested]) {
      if (!Array.isArray(value)) continue;
      for (const entry of value) {
        if (typeof entry === "string" && path.isAbsolute(entry)) out.add(path.resolve(entry));
      }
    }
  } catch {
    // An invalid CODEX_CONFIG is ignored by the engine as well.
  }
  return [...out];
}

/** `a === b` or `b` is a proper ancestor of `a` (canonical absolute paths). */
export function isInsidePath(a: string, b: string): boolean {
  if (a === b) return true;
  const prefix = b.endsWith(path.sep) ? b : b + path.sep;
  return a.startsWith(prefix);
}

function ancestorsOf(p: string): string[] {
  const chain: string[] = [];
  let current = path.dirname(p);
  for (;;) {
    chain.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return chain;
}

/**
 * Read admissions from the server-built workspace context. Anything other than
 * an array of well-formed `{path, ruleIndex, issueId}` records is rejected as a
 * whole (fail closed).
 */
export function readTrustedWriteRootAdmissions(workspaceContext: Record<string, unknown>): {
  admissions: TrustedWriteRootAdmissionRecord[];
  rulesHash: string | null;
  malformed: boolean;
} {
  const raw = workspaceContext.trustedWriteRoots;
  const hashValue = workspaceContext.trustedWriteRootsRulesHash;
  const rulesHash = typeof hashValue === "string" && /^[0-9a-f]{12}$/.test(hashValue) ? hashValue : null;
  if (raw === undefined || raw === null) return { admissions: [], rulesHash, malformed: false };
  if (!Array.isArray(raw)) return { admissions: [], rulesHash, malformed: true };
  const admissions: TrustedWriteRootAdmissionRecord[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return { admissions: [], rulesHash, malformed: true };
    const record = entry as Record<string, unknown>;
    if (
      typeof record.path !== "string" || record.path.length === 0 ||
      typeof record.issueId !== "string" || record.issueId.length === 0 ||
      typeof record.ruleIndex !== "number" || !Number.isInteger(record.ruleIndex) || record.ruleIndex < 0
    ) {
      return { admissions: [], rulesHash, malformed: true };
    }
    admissions.push({ path: record.path, ruleIndex: record.ruleIndex, issueId: record.issueId });
  }
  return { admissions, rulesHash, malformed: false };
}

async function canonicalWritableRoots(roots: readonly string[], fs: TrustedWriteRootFs): Promise<string[]> {
  const out = new Set<string>();
  for (const root of roots) {
    if (typeof root !== "string" || root.length === 0 || !path.isAbsolute(root)) continue;
    const resolved = path.resolve(root);
    // Keep both spellings: a lexical writable root and its realpath both count.
    out.add(resolved);
    try {
      out.add(await fs.realpath(resolved));
    } catch {
      // A missing writable root still constrains its lexical subtree.
    }
  }
  return [...out];
}

async function checkCandidate(
  candidate: string,
  writable: readonly string[],
  otherCandidates: readonly string[],
  serverUid: number,
  fs: TrustedWriteRootFs,
): Promise<{ ok: true; identity: TrustedWriteRootIdentity } | { ok: false; reason: string }> {
  // (1) absolute, normalized and canonical.
  if (!path.isAbsolute(candidate) || path.resolve(candidate) !== candidate) {
    return { ok: false, reason: "not an absolute normalized path" };
  }
  if (FORBIDDEN_ROOTS.has(candidate)) return { ok: false, reason: "forbidden root" };
  let real: string;
  try {
    real = await fs.realpath(candidate);
  } catch {
    return { ok: false, reason: "missing" };
  }
  if (real !== candidate) return { ok: false, reason: "not canonical (realpath differs)" };
  // (3a) not inside a writable subtree; (3b) does not contain a writable root.
  for (const w of writable) {
    if (isInsidePath(candidate, w)) return { ok: false, reason: "inside a run writable root" };
    if (isInsidePath(w, candidate)) return { ok: false, reason: "contains a run writable root" };
  }
  // (3c) no nesting between trusted roots.
  for (const other of otherCandidates) {
    if (isInsidePath(candidate, other) || isInsidePath(other, candidate)) {
      return { ok: false, reason: "nested with another trusted root" };
    }
  }
  // (2) + (4) the root and every ancestor: real directory, no symlink, owned by
  // root or the server uid, not group/world writable. (6) the identity comes
  // from the same lstat of the root.
  let identity: TrustedWriteRootIdentity | null = null;
  for (const component of [candidate, ...ancestorsOf(candidate)]) {
    let stat;
    try {
      stat = await fs.lstat(component);
    } catch {
      return { ok: false, reason: component === candidate ? "missing" : "ancestor missing" };
    }
    const label = component === candidate ? "root" : "ancestor";
    if (stat.isSymbolicLink()) return { ok: false, reason: `${label} is a symlink` };
    if (!stat.isDirectory()) return { ok: false, reason: `${label} is not a directory` };
    if (stat.uid !== 0 && stat.uid !== serverUid) return { ok: false, reason: `${label} has an untrusted owner` };
    if ((stat.mode & (fsConstants.S_IWGRP | fsConstants.S_IWOTH)) !== 0) {
      return { ok: false, reason: `${label} is group or world writable` };
    }
    if (component === candidate) identity = { path: candidate, dev: stat.dev, ino: stat.ino };
  }
  // (5) no repository, Codex or agent-skill entry inside the root. Only a
  // confirmed ENOENT counts as absent; any other lookup error (EACCES, EIO, ...)
  // leaves absence unknown and drops the root.
  for (const entry of FORBIDDEN_ENTRIES) {
    try {
      await fs.lexists(path.join(candidate, entry));
      return { ok: false, reason: `contains ${entry}` };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (code === "ENOENT") continue;
      return { ok: false, reason: `cannot inspect ${entry} (${typeof code === "string" ? code : "unknown error"})` };
    }
  }
  return identity ? { ok: true, identity } : { ok: false, reason: "missing" };
}

/** Validate admitted roots against the run's writable roots. Any failure drops that root. */
export async function validateTrustedWriteRoots(
  admissions: readonly { path: string }[],
  options: TrustedWriteRootValidationOptions,
): Promise<TrustedWriteRootValidation> {
  const fs = options.fs ?? defaultTrustedWriteRootFs;
  const serverUid = options.serverUid ?? (typeof process.getuid === "function" ? process.getuid() : -1);
  const writable = await canonicalWritableRoots(options.runWritableRoots, fs);
  const candidates = [...new Set(admissions.map((admission) => admission.path))];
  const roots: TrustedWriteRootIdentity[] = [];
  const rejected: TrustedWriteRootRejection[] = [];
  for (const candidate of candidates) {
    const others = candidates.filter((other) => other !== candidate);
    const result = await checkCandidate(candidate, writable, others, serverUid, fs);
    if (result.ok) roots.push(result.identity);
    else rejected.push({ path: candidate, reason: result.reason });
  }
  return { roots, rejected };
}

/**
 * Re-run the full validation for already-validated roots and require the same
 * `{dev, ino}`. Used at the launch boundary and before a prompt on a borrowed
 * warm handle.
 */
export async function revalidateTrustedWriteRoots(
  roots: readonly TrustedWriteRootIdentity[],
  options: TrustedWriteRootValidationOptions,
): Promise<TrustedWriteRootValidation> {
  if (roots.length === 0) return { roots: [], rejected: [] };
  const fresh = await validateTrustedWriteRoots(roots, options);
  const kept: TrustedWriteRootIdentity[] = [];
  const rejected = [...fresh.rejected];
  for (const root of roots) {
    const current = fresh.roots.find((entry) => entry.path === root.path);
    if (!current) continue;
    if (current.dev !== root.dev || current.ino !== root.ino) {
      rejected.push({ path: root.path, reason: "identity changed" });
      continue;
    }
    kept.push(root);
  }
  return { roots: kept, rejected };
}

export function sameTrustedWriteRoots(
  a: readonly TrustedWriteRootIdentity[],
  b: readonly TrustedWriteRootIdentity[],
): boolean {
  return a.length === b.length && a.every((root, index) =>
    root.path === b[index]?.path && root.dev === b[index]?.dev && root.ino === b[index]?.ino);
}

export function formatTrustedWriteRootsLaunchLine(input: {
  roots: readonly TrustedWriteRootIdentity[];
  admissions: readonly TrustedWriteRootAdmissionRecord[];
  rulesHash: string | null;
  rejected: readonly TrustedWriteRootRejection[];
}): string {
  const roots = JSON.stringify(input.roots.map((root) => ({ path: root.path, dev: root.dev, ino: root.ino })));
  const admission = JSON.stringify(input.admissions.map((entry) => ({ issueId: entry.issueId, ruleIndex: entry.ruleIndex })));
  const rules = input.rulesHash ? `sha256:${input.rulesHash}` : "none";
  return `[paperclip] Codex trusted write roots: ${roots} admission=${admission} rules=${rules} rejected=${JSON.stringify(input.rejected)}\n`;
}
