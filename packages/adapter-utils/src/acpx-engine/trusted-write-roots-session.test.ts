import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAcpxEngineExecutor } from "./execute.js";
import { createSessionReuseStore } from "./session-reuse-store.js";
import type { RuntimeCacheEntry } from "./run-site-host.js";
import type { TrustedWriteRootFs } from "./trusted-write-roots.js";

// §4.4 session revocation, engine level, with a fake runtime, a seeded host
// store and a fake filesystem for the trusted roots (the fixture roots live
// only in the fake fs; nothing outside this test's temp dir is created).
// Each transition runs on both paths:
//   * warm: an idle entry spawned under the previous key sits in the host
//     store; the next run must not borrow it, and discards it while idle;
//   * persisted: the previous run's saved sessionParams; the next run must
//     not resume them (no resumeSessionId).

const CACHE = "/fx/worktrees/cache";
const OTHER = "/fx/worktrees/other";
const uid = typeof process.getuid === "function" ? process.getuid() : 0;
const RULES_HASH = "0123456789ab";

const tempRoots: string[] = [];
afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

/** A mutable fake of the trusted-root filesystem: `/`, `/fx`, `/fx/worktrees` and its children. */
function createFakeFs() {
  const dirs = new Map<string, { ino: number; mode: number }>([
    ["/", { ino: 2, mode: 0o040555 }],
    ["/fx", { ino: 10, mode: 0o040755 }],
    ["/fx/worktrees", { ino: 11, mode: 0o040755 }],
    [CACHE, { ino: 100, mode: 0o040755 }],
    [OTHER, { ino: 200, mode: 0o040755 }],
  ]);
  const fakeFs: TrustedWriteRootFs = {
    lstat: async (p) => {
      const entry = dirs.get(p);
      if (!entry) throw Object.assign(new Error(`ENOENT ${p}`), { code: "ENOENT" });
      return { dev: 7, ino: entry.ino, uid, mode: entry.mode, isDirectory: () => true, isSymbolicLink: () => false };
    },
    realpath: async (p) => {
      if (p.startsWith("/fx") && !dirs.has(p)) throw new Error(`ENOENT ${p}`);
      return p;
    },
    lexists: async (p) => {
      if (!dirs.has(p)) throw new Error(`ENOENT ${p}`);
    },
  };
  return { dirs, fakeFs, replace: (p: string) => { dirs.get(p)!.ino += 1000; } };
}

type Admission = { path: string; ruleIndex: number; issueId: string };
const admit = (p: string): Admission => ({ path: p, ruleIndex: 0, issueId: "issue-1" });

function fakeRuntime(record: { ensureInputs: Record<string, unknown>[]; turns: number; closes: number }) {
  return {
    ensureSession: async (input: Record<string, unknown>) => {
      record.ensureInputs.push(input);
      return { backendSessionId: `acp-${record.ensureInputs.length}`, agentSessionId: "agent-session", runtimeSessionName: "runtime-session" };
    },
    startTurn: () => {
      record.turns += 1;
      return {
        events: (async function* () { yield { type: "done", stopReason: "end_turn" }; })(),
        result: Promise.resolve({ status: "completed" as const, stopReason: "end_turn" }),
        cancel: async () => {},
      };
    },
    setConfigOption: async () => {},
    close: async () => { record.closes += 1; },
  };
}

async function setup(configEnv?: Record<string, string>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-trusted-session-"));
  tempRoots.push(root);
  const cwd = path.join(root, "workspace");
  await fs.mkdir(cwd, { recursive: true });
  const warmHandles = new Map<string, RuntimeCacheEntry>();
  const fakeFsState = createFakeFs();
  const fresh = { ensureInputs: [] as Record<string, unknown>[], turns: 0, closes: 0 };
  const execute = createAcpxEngineExecutor({
    warmHandles,
    trustedWriteRootFs: fakeFsState.fakeFs,
    trustedWriteRootServerUid: uid,
    createRuntime: () => fakeRuntime(fresh) as never,
  });
  const config = { agent: "codex", cwd, stateDir: path.join(root, "state"), warmHandleIdleMs: 60_000, ...(configEnv ? { env: configEnv } : {}) };
  let runCount = 0;
  async function run(admissions: Admission[] | null, sessionParams?: Record<string, unknown>, onLog?: (text: string) => void) {
    runCount += 1;
    const logs: string[] = [];
    const ensureBefore = fresh.ensureInputs.length;
    const result = await execute({
      runId: `run-${runCount}`,
      agent: { id: "agent-1", companyId: "company-1" },
      runtime: sessionParams ? { sessionParams } : {},
      config,
      context: {
        taskId: "issue-1",
        paperclipWorkspace: admissions === null
          ? { cwd }
          : { cwd, trustedWriteRoots: admissions, trustedWriteRootsRulesHash: RULES_HASH },
      },
      onLog: async (_stream: string, text: string) => { logs.push(text); onLog?.(text); },
      onMeta: async () => {},
    } as never);
    const ensure = fresh.ensureInputs.slice(ensureBefore);
    const env = (ensure[0]?.sessionOptions as { env?: Record<string, string> } | undefined)?.env;
    return { result, logs, ensure, childRoots: env ? JSON.parse(env.PAPERCLIP_CODEX_ACP_TRUSTED_WRITE_ROOTS ?? "null") : undefined };
  }
  /** Seed an idle warm entry under `sessionKey`, as if the previous run kept its runtime. */
  function seedWarm(sessionKey: string) {
    const record = { ensureInputs: [] as Record<string, unknown>[], turns: 0, closes: 0 };
    const entry: RuntimeCacheEntry = {
      runtime: fakeRuntime(record) as never,
      handle: { sessionKey, backend: "codex", runtimeSessionName: "runtime-session", backendSessionId: "acp-warm" } as never,
      childStderrState: { logPath: null, pendingLiveLine: "" } as never,
      processIdentitySink: { current: undefined, latest: null } as never,
      fingerprint: String(sessionKey.split(":").pop()),
      lastUsedAt: Date.now(),
    };
    warmHandles.set(sessionKey, entry);
    return { entry, record };
  }
  return { run, seedWarm, warmHandles, fakeFsState, fresh };
}

const cacheIdentity = (ino = 100) => [{ path: CACHE, dev: 7, ino }];

describe("trusted write-root session revocation (§4.4)", () => {
  const transitions: Array<{
    name: string;
    first: Admission[] | null;
    second: Admission[] | null;
    between?: (state: Awaited<ReturnType<typeof setup>>) => void;
    expectedSecondRoots: unknown;
  }> = [
    { name: "empty → grant", first: [], second: [admit(CACHE)], expectedSecondRoots: cacheIdentity() },
    { name: "grant → different root", first: [admit(CACHE)], second: [admit(OTHER)], expectedSecondRoots: [{ path: OTHER, dev: 7, ino: 200 }] },
    { name: "grant → empty (rule removed)", first: [admit(CACHE)], second: [], expectedSecondRoots: [] },
    // The server resolves no admission for a planning issue (server matrix
    // (h)); the engine then sees the same task with no admissions.
    { name: "granted standard → planning", first: [admit(CACHE)], second: [], expectedSecondRoots: [] },
    {
      name: "grant → same path with a new identity",
      first: [admit(CACHE)],
      second: [admit(CACHE)],
      between: (state) => state.fakeFsState.replace(CACHE),
      expectedSecondRoots: cacheIdentity(1100),
    },
  ];

  for (const transition of transitions) {
    it(`${transition.name}: persisted session is not resumed`, async () => {
      const state = await setup();
      const first = await state.run(transition.first);
      expect(first.result.exitCode).toBe(0);
      transition.between?.(state);
      const second = await state.run(transition.second, first.result.sessionParams as Record<string, unknown>);
      expect(second.result.exitCode).toBe(0);
      expect(second.result.sessionParams?.configFingerprint).not.toBe(first.result.sessionParams?.configFingerprint);
      expect(second.result.sessionParams?.sessionKey).not.toBe(first.result.sessionParams?.sessionKey);
      expect(second.ensure).toHaveLength(1);
      expect(second.ensure[0]?.resumeSessionId).toBeUndefined();
      expect(second.childRoots).toEqual(transition.expectedSecondRoots);
      expect(second.logs.some((line) => line.startsWith("[paperclip] warm handle miss "))).toBe(true);
    });

    it(`${transition.name}: idle warm handle is not borrowed and is discarded`, async () => {
      const state = await setup();
      const first = await state.run(transition.first);
      const firstKey = String(first.result.sessionParams?.sessionKey);
      const warm = state.seedWarm(firstKey);
      transition.between?.(state);
      const second = await state.run(transition.second, first.result.sessionParams as Record<string, unknown>);
      expect(second.result.exitCode).toBe(0);
      expect(warm.record.turns).toBe(0);
      expect(warm.record.closes).toBe(1);
      expect(state.warmHandles.has(firstKey)).toBe(false);
      expect(second.ensure[0]?.resumeSessionId).toBeUndefined();
      expect(second.childRoots).toEqual(transition.expectedSecondRoots);
      expect(second.logs.some((line) => /^\[paperclip\] warm handle discarded key=sha256:[0-9a-f]{12} /.test(line))).toBe(true);
    });
  }

  it("never discards a borrowed warm entry of the same task", async () => {
    const state = await setup();
    const first = await state.run([admit(CACHE)]);
    const firstKey = String(first.result.sessionParams?.sessionKey);
    const warm = state.seedWarm(firstKey);
    // An overlapping live run holds this entry.
    createSessionReuseStore<RuntimeCacheEntry>({
      entries: state.warmHandles, now: Date.now, idleMs: 60_000, lastUsedAt: (entry) => entry.lastUsedAt, release: () => {},
    }).borrow(firstKey);
    const second = await state.run([], first.result.sessionParams as Record<string, unknown>);
    expect(second.result.exitCode).toBe(0);
    expect(warm.record.turns).toBe(0);
    expect(warm.record.closes).toBe(0);
    expect(state.warmHandles.get(firstKey)).toBe(warm.entry);
    expect(second.childRoots).toEqual([]);
  });

  it("empty → empty keeps the legacy fingerprint and still resumes", async () => {
    const state = await setup();
    const legacy = await state.run(null);
    const empty = await state.run([]);
    expect(empty.result.sessionParams?.configFingerprint).toBe(legacy.result.sessionParams?.configFingerprint);
    const resumed = await state.run([], empty.result.sessionParams as Record<string, unknown>);
    expect(resumed.ensure[0]?.resumeSessionId).toBe(empty.result.sessionParams?.acpSessionId);
    expect(resumed.childRoots).toEqual([]);
    // No trusted-root record is added to a run with nothing admitted or rejected.
    expect((resumed.result.resultJson as Record<string, unknown>).trustedWriteRoots).toBeUndefined();
  });

  it("grant → same grant resumes the persisted session and borrows the warm handle", async () => {
    const state = await setup();
    const first = await state.run([admit(CACHE)]);
    expect(first.childRoots).toEqual(cacheIdentity());
    expect((first.result.resultJson as Record<string, unknown>).trustedWriteRoots).toEqual({
      roots: cacheIdentity(), admission: [{ issueId: "issue-1", ruleIndex: 0 }], rulesHash: RULES_HASH, rejected: [],
    });
    expect(first.logs).toContain(
      `[paperclip] Codex trusted write roots: ${JSON.stringify(cacheIdentity())} admission=[{"issueId":"issue-1","ruleIndex":0}] rules=sha256:${RULES_HASH} rejected=[]\n`,
    );
    const resumed = await state.run([admit(CACHE)], first.result.sessionParams as Record<string, unknown>);
    expect(resumed.ensure[0]?.resumeSessionId).toBe(first.result.sessionParams?.acpSessionId);
    const warm = state.seedWarm(String(first.result.sessionParams?.sessionKey));
    const borrowed = await state.run([admit(CACHE)], first.result.sessionParams as Record<string, unknown>);
    expect(borrowed.result.exitCode).toBe(0);
    expect(warm.record.turns).toBe(1);
    expect(borrowed.logs.some((line) => line.startsWith("[paperclip] warm handle borrowed "))).toBe(true);
  });

  it("drops a root replaced between prepare and launch, and keys the run for the reduced set", async () => {
    const state = await setup();
    const first = await state.run([admit(CACHE)]);
    const warm = state.seedWarm(String(first.result.sessionParams?.sessionKey));
    let replaced = false;
    // The replacement lands after prepare's validation (the timeout line is
    // logged between prepare and the launch boundary).
    const second = await state.run([admit(CACHE)], first.result.sessionParams as Record<string, unknown>, (text) => {
      if (!replaced && text.includes("timeout")) { replaced = true; state.fakeFsState.replace(CACHE); }
    });
    expect(replaced).toBe(true);
    expect(second.result.exitCode).toBe(0);
    expect(second.logs).toContain(`[paperclip] trusted write root dropped at launch: ${CACHE} (identity changed)\n`);
    expect(second.childRoots).toEqual([]);
    expect(second.ensure[0]?.resumeSessionId).toBeUndefined();
    expect(warm.record.turns).toBe(0);
    expect((second.result.resultJson as Record<string, unknown>).trustedWriteRoots).toMatchObject({
      roots: [], rejected: [{ path: CACHE, reason: "identity changed" }],
    });
  });

  it("sends no prompt when a borrowed warm runtime's root changes before the prompt", async () => {
    const state = await setup();
    const first = await state.run([admit(CACHE)]);
    const warm = state.seedWarm(String(first.result.sessionParams?.sessionKey));
    const second = await state.run([admit(CACHE)], first.result.sessionParams as Record<string, unknown>, (text) => {
      if (text.startsWith("[paperclip] warm handle borrowed ")) state.fakeFsState.replace(CACHE);
    });
    expect(second.result.exitCode).toBe(1);
    expect(warm.record.turns).toBe(0);
    expect(warm.record.closes).toBe(1);
    expect(second.logs).toContain(`[paperclip] trusted write root dropped before prompt: ${CACHE} (identity changed)\n`);
  });

  it("rejects an invalid admitted root with no grant and records why", async () => {
    const state = await setup();
    const run = await state.run([admit("/fx/worktrees/missing"), admit("relative/path")]);
    expect(run.result.exitCode).toBe(0);
    expect(run.childRoots).toEqual([]);
    expect((run.result.resultJson as Record<string, unknown>).trustedWriteRoots).toMatchObject({
      roots: [],
      rejected: [
        { path: "/fx/worktrees/missing", reason: "missing" },
        { path: "relative/path", reason: "not an absolute normalized path" },
      ],
    });
  });

  it("rejects a malformed admission context with no grant", async () => {
    const state = await setup();
    const malformed = await state.run([{ path: CACHE } as unknown as Admission]);
    expect(malformed.childRoots).toEqual([]);
    expect((malformed.result.resultJson as Record<string, unknown>).trustedWriteRoots).toMatchObject({
      roots: [], rejected: [{ path: "", reason: "malformed admission context" }],
    });
  });

  it("ignores trusted write-root channels injected through adapter config env", async () => {
    const injected = JSON.stringify(cacheIdentity());
    const state = await setup({
      PAPERCLIP_CODEX_ACP_TRUSTED_WRITE_ROOTS: injected,
      PAPERCLIP_TRUSTED_WRITE_ROOTS: JSON.stringify([{ path: CACHE }]),
    });
    const run = await state.run(null);
    expect(run.result.exitCode).toBe(0);
    expect(run.childRoots).toEqual([]);
    const env = (run.ensure[0]?.sessionOptions as { env: Record<string, string> }).env;
    expect(env.PAPERCLIP_TRUSTED_WRITE_ROOTS).toBeUndefined();
  });
});
