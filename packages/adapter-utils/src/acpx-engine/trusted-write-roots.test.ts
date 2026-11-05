import { mkdir, mkdtemp, realpath, rename, rm, symlink, chmod, lstat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  collectRunWritableRoots,
  defaultTrustedWriteRootFs,
  formatTrustedWriteRootsLaunchLine,
  isInsidePath,
  readTrustedWriteRootAdmissions,
  revalidateTrustedWriteRoots,
  validateTrustedWriteRoots,
  type TrustedWriteRootFs,
} from "./trusted-write-roots.js";

// §4.2 validator tests. The topology fixtures build a base `B` under the OS
// temp dir and pass an explicit `runWritableRoots`, so the predicate is tested
// apart from the real cwd. These are filesystem assertions inside an already
// permitted temp root; they do NOT prove namespace (EROFS) enforcement — that
// is the §4.5 script and the live §4.6 rows.

let base: string;
let tmpAncestors: Set<string>;
const uid = typeof process.getuid === "function" ? process.getuid() : 0;

/**
 * Real fs, except the ancestors of `B` (for example a sticky world-writable
 * `/tmp`) report the root-owned 0755 layout the real cache has above it. The
 * candidate, `B` and everything under `B` are real.
 */
function fixtureFs(): TrustedWriteRootFs {
  return {
    ...defaultTrustedWriteRootFs,
    lstat: async (p) => {
      const stat = await lstat(p);
      if (!tmpAncestors.has(p)) return stat;
      return {
        dev: stat.dev, ino: stat.ino, uid: 0, mode: 0o040755,
        isDirectory: () => true, isSymbolicLink: () => false,
      };
    },
  };
}

beforeEach(async () => {
  base = await realpath(await mkdtemp(path.join(os.tmpdir(), "paperclip-trusted-root-")));
  await chmod(base, 0o755);
  tmpAncestors = new Set();
  for (let current = path.dirname(base); ; current = path.dirname(current)) {
    tmpAncestors.add(current);
    if (path.dirname(current) === current) break;
  }
  for (const dir of ["projects/nk", "tmp", "tmpdir", "home", "worktrees/cache", "worktrees/other", "worktrees/pw/cache"]) {
    await mkdir(path.join(base, dir), { recursive: true, mode: 0o755 });
  }
  for (const dir of ["projects", "projects/nk", "tmp", "tmpdir", "home", "worktrees", "worktrees/cache", "worktrees/other", "worktrees/pw", "worktrees/pw/cache"]) {
    await chmod(path.join(base, dir), 0o755);
  }
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

function writable(extra: string[] = []) {
  return [path.join(base, "projects/nk"), path.join(base, "tmp"), path.join(base, "tmpdir"), path.join(base, "home"), ...extra];
}

async function validate(paths: string[], runWritableRoots = writable()) {
  return validateTrustedWriteRoots(paths.map((p) => ({ path: p })), { runWritableRoots, serverUid: uid, fs: fixtureFs() });
}

describe("trusted write-root topology (§4.2a/b)", () => {
  it("accepts a disjoint cache that shares ancestors with cwd and tmp, recording dev/ino", async () => {
    const cache = path.join(base, "worktrees/cache");
    const result = await validate([cache]);
    const stat = await lstat(cache);
    expect(result.rejected).toEqual([]);
    expect(result.roots).toEqual([{ path: cache, dev: stat.dev, ino: stat.ino }]);
  });

  it.each([
    ["root under cwd", "projects/nk/cache", "inside a run writable root"],
    ["root equal to cwd", "projects/nk", "inside a run writable root"],
    ["root under /tmp", "tmp/cache", "inside a run writable root"],
    ["root under $TMPDIR", "tmpdir/cache", "inside a run writable root"],
    ["root under the agent home", "home/cache", "inside a run writable root"],
    ["root containing cwd", "projects", "contains a run writable root"],
    ["root equal to the base", "", "contains a run writable root"],
  ])("rejects %s", async (_label, relative, reason) => {
    const candidate = path.join(base, relative);
    await mkdir(candidate, { recursive: true, mode: 0o755 });
    const result = await validate([candidate.replace(/\/$/, "")]);
    expect(result.roots).toEqual([]);
    expect(result.rejected).toEqual([{ path: candidate.replace(/\/$/, ""), reason }]);
  });

  it("rejects a candidate whose parent is writable (parent-writable)", async () => {
    const candidate = path.join(base, "worktrees/pw/cache");
    const result = await validate([candidate], writable([path.join(base, "worktrees/pw")]));
    expect(result.rejected).toEqual([{ path: candidate, reason: "inside a run writable root" }]);
  });

  it("rejects both nested trusted candidates", async () => {
    const outer = path.join(base, "worktrees/pw");
    const inner = path.join(base, "worktrees/pw/cache");
    const result = await validate([outer, inner]);
    expect(result.roots).toEqual([]);
    expect(result.rejected.map((entry) => entry.reason)).toEqual(["nested with another trusted root", "nested with another trusted root"]);
  });

  it("rejects group- or world-writable ancestors and roots", async () => {
    await chmod(path.join(base, "worktrees"), 0o775);
    expect((await validate([path.join(base, "worktrees/cache")])).rejected).toEqual([
      { path: path.join(base, "worktrees/cache"), reason: "ancestor is group or world writable" },
    ]);
    await chmod(path.join(base, "worktrees"), 0o755);
    await chmod(path.join(base, "worktrees/cache"), 0o757);
    expect((await validate([path.join(base, "worktrees/cache")])).rejected).toEqual([
      { path: path.join(base, "worktrees/cache"), reason: "root is group or world writable" },
    ]);
  });

  it("rejects an ancestor owned by another uid", async () => {
    const cache = path.join(base, "worktrees/cache");
    const result = await validateTrustedWriteRoots([{ path: cache }], {
      runWritableRoots: writable(), serverUid: uid,
      fs: { ...fixtureFs(), lstat: async (p) => {
        const stat = await fixtureFs().lstat(p);
        return p === path.join(base, "worktrees") ? { ...pickStat(stat), uid: uid + 7 === 0 ? 1 : uid + 7 } : stat;
      } },
    });
    expect(result.rejected).toEqual([{ path: cache, reason: "ancestor has an untrusted owner" }]);
  });

  it("checks the real deployment layout lexically (no real path touched)", async () => {
    // §3.4(3) synthetic check. Only the predicate is exercised, through a
    // fake fs that reports the documented live modes; this is not namespace proof.
    const fakeDirs = new Map<string, { uid: number; mode: number }>([
      ["/", { uid: 0, mode: 0o040555 }],
      ["/paperclip", { uid, mode: 0o040700 }],
      ["/paperclip/worktrees", { uid, mode: 0o040755 }],
      ["/paperclip/worktrees/VIK-1691-cache", { uid, mode: 0o040755 }],
      ["/paperclip/worktrees/vik-2207-fx-root", { uid, mode: 0o040755 }],
      ["/paperclip/worktrees/vik-2207-fx-root/sub", { uid, mode: 0o040755 }],
      ["/paperclip/worktrees/vik-2207-fx-pw", { uid, mode: 0o040755 }],
      ["/paperclip/worktrees/vik-2207-fx-pw/cache", { uid, mode: 0o040755 }],
      ["/paperclip/projects", { uid, mode: 0o040755 }],
      ["/paperclip/projects/Northern-Kingdoms", { uid, mode: 0o040755 }],
      ["/paperclip/projects/Northern-Kingdoms/cache", { uid, mode: 0o040755 }],
      ["/tmp", { uid: 0, mode: 0o041777 }],
      ["/tmp/fx", { uid, mode: 0o040755 }],
    ]);
    let ino = 100;
    const inodes = new Map([...fakeDirs.keys()].map((p) => [p, ino++]));
    const fakeFs: TrustedWriteRootFs = {
      lstat: async (p) => {
        const entry = fakeDirs.get(p);
        if (!entry) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return { dev: 1, ino: inodes.get(p)!, uid: entry.uid, mode: entry.mode, isDirectory: () => true, isSymbolicLink: () => false };
      },
      realpath: async (p) => {
        if (!fakeDirs.has(p) && !p.startsWith("/paperclip/instances")) throw new Error("ENOENT");
        return p;
      },
      readdir: async () => [],
      lexists: async (p) => {
        if (!fakeDirs.has(p)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
    };
    const W = ["/paperclip/projects/Northern-Kingdoms", "/tmp", "/paperclip/instances/default/tmp/run", "/paperclip/instances/default/workspaces/agent"];
    const check = async (candidate: string, extra: string[] = []) =>
      validateTrustedWriteRoots([{ path: candidate }], { runWritableRoots: [...W, ...extra], serverUid: uid, fs: fakeFs });
    expect((await check("/paperclip/worktrees/VIK-1691-cache")).roots).toHaveLength(1);
    expect((await check("/paperclip/worktrees/vik-2207-fx-root")).roots).toHaveLength(1);
    for (const rejected of ["/paperclip/projects/Northern-Kingdoms/cache", "/tmp/fx", "/paperclip/projects/Northern-Kingdoms"]) {
      expect((await check(rejected)).rejected[0]?.reason).toBe("inside a run writable root");
    }
    expect((await check("/paperclip/projects")).rejected[0]?.reason).toBe("contains a run writable root");
    for (const forbidden of ["/paperclip", "/"]) {
      expect((await check(forbidden)).rejected[0]?.reason).toBe("forbidden root");
    }
    expect((await check("/paperclip/worktrees/vik-2207-fx-pw/cache", ["/paperclip/worktrees/vik-2207-fx-pw"])).rejected[0]?.reason)
      .toBe("inside a run writable root");
    const nested = await validateTrustedWriteRoots(
      [{ path: "/paperclip/worktrees/vik-2207-fx-root" }, { path: "/paperclip/worktrees/vik-2207-fx-root/sub" }],
      { runWritableRoots: W, serverUid: uid, fs: fakeFs },
    );
    expect(nested.roots).toEqual([]);
  });
});

function pickStat(stat: Awaited<ReturnType<TrustedWriteRootFs["lstat"]>>) {
  return { dev: stat.dev, ino: stat.ino, uid: stat.uid, mode: stat.mode, isDirectory: () => stat.isDirectory(), isSymbolicLink: () => stat.isSymbolicLink() };
}

describe("trusted write-root path and entry checks (§4.2d)", () => {
  it.each([
    ["a relative path", "worktrees/cache", "not an absolute normalized path"],
    ["an unnormalized path", "__BASE__/worktrees/../worktrees/cache", "not an absolute normalized path"],
    ["a trailing slash", "__BASE__/worktrees/cache/", "not an absolute normalized path"],
    ["a missing directory", "__BASE__/worktrees/missing", "missing"],
    ["the forbidden /paperclip/worktrees", "/paperclip/worktrees", "forbidden root"],
  ])("rejects %s", async (_label, raw, reason) => {
    const candidate = raw.replace("__BASE__", base);
    expect((await validate([candidate])).rejected).toEqual([{ path: candidate, reason }]);
  });

  it("rejects a symlinked root and a symlinked ancestor", async () => {
    await symlink(path.join(base, "worktrees/other"), path.join(base, "worktrees/link"));
    expect((await validate([path.join(base, "worktrees/link")])).rejected[0]?.reason).toBe("not canonical (realpath differs)");
    await symlink(path.join(base, "worktrees"), path.join(base, "wt-link"));
    expect((await validate([path.join(base, "wt-link/cache")])).rejected[0]?.reason).toBe("not canonical (realpath differs)");
  });

  it.each([".agents", ".codex", ".git"])("rejects a root containing %s", async (entry) => {
    await mkdir(path.join(base, "worktrees/cache", entry));
    await writeFile(path.join(base, "worktrees/cache", entry, "content"), "data");
    expect((await validate([path.join(base, "worktrees/cache")])).rejected[0]?.reason).toBe(`contains ${entry}`);
  });

  it("admits consecutive runs after empty server-owned sandbox targets appear", async () => {
    const cache = path.join(base, "worktrees/cache");
    const first = await validate([cache]);
    for (const entry of [".git", ".codex", ".agents", ".aws"]) {
      await mkdir(path.join(cache, entry), { mode: 0o555 });
    }
    expect(await validate([cache])).toEqual(first);
    expect(await revalidateTrustedWriteRoots(first.roots, {
      runWritableRoots: writable(), serverUid: uid, fs: fixtureFs(),
    })).toEqual(first);
  });

  it.each([".git", ".codex", ".agents"])("rejects a symlink placeholder %s", async (entry) => {
    const cache = path.join(base, "worktrees/cache");
    await symlink(path.join(base, "worktrees/other"), path.join(cache, entry));
    expect((await validate([cache])).rejected[0]?.reason).toBe(`contains ${entry}`);
  });

  it.each(["foreign owner", "group writable", "world writable", "file", "replaced", "unreadable"])(
    "rejects an empty placeholder that is %s", async (scenario) => {
      const cache = path.join(base, "worktrees/cache");
      const entry = path.join(cache, ".git");
      await mkdir(entry);
      let reads = 0;
      const fs: TrustedWriteRootFs = {
        ...fixtureFs(),
        lstat: async (p) => {
          const stat = await fixtureFs().lstat(p);
          if (p !== entry) return stat;
          reads += 1;
          return { ...pickStat(stat),
            uid: scenario === "foreign owner" ? uid + 7 : stat.uid,
            mode: stat.mode | (scenario === "group writable" ? 0o020 : scenario === "world writable" ? 0o002 : 0),
            ino: stat.ino + (scenario === "replaced" && reads > 1 ? 1 : 0),
            isDirectory: () => scenario !== "file",
          };
        },
        readdir: async (p) => {
          if (scenario === "unreadable") throw Object.assign(new Error("denied"), { code: "EACCES" });
          return defaultTrustedWriteRootFs.readdir(p);
        },
      };
      const result = await validateTrustedWriteRoots([{ path: cache }], { runWritableRoots: writable(), serverUid: uid, fs });
      expect(result.roots).toEqual([]);
      expect(result.rejected[0]?.reason).toBe(scenario === "unreadable" ? "cannot inspect .git (EACCES)" : "contains .git");
    },
  );

  it.each([
    ["EACCES", { code: "EACCES" }, "cannot inspect .git (EACCES)"],
    ["EIO", { code: "EIO" }, "cannot inspect .git (EIO)"],
    ["an error without a code", {}, "cannot inspect .git (unknown error)"],
  ])("rejects a root whose entry lookup fails with %s", async (_label, fields, reason) => {
    const cache = path.join(base, "worktrees/cache");
    const fs: TrustedWriteRootFs = {
      ...fixtureFs(),
      lexists: async () => {
        throw Object.assign(new Error("lookup failed"), fields);
      },
    };
    const result = await validateTrustedWriteRoots([{ path: cache }], { runWritableRoots: writable(), serverUid: uid, fs });
    expect(result).toEqual({ roots: [], rejected: [{ path: cache, reason }] });
  });

  it.skipIf(uid === 0)("rejects a root without search permission (real EACCES)", async () => {
    const cache = path.join(base, "worktrees/cache");
    await chmod(cache, 0o600);
    try {
      expect((await validate([cache])).rejected).toEqual([{ path: cache, reason: "cannot inspect .git (EACCES)" }]);
    } finally {
      await chmod(cache, 0o755);
    }
  });
});

describe("trusted write-root replacement after prepare (§4.2d)", () => {
  async function prepared() {
    const cache = path.join(base, "worktrees/cache");
    const result = await validate([cache]);
    expect(result.roots).toHaveLength(1);
    return result.roots;
  }
  const options = () => ({ runWritableRoots: writable(), serverUid: uid, fs: fixtureFs() });

  it("keeps an unchanged root", async () => {
    const roots = await prepared();
    expect(await revalidateTrustedWriteRoots(roots, options())).toEqual({ roots, rejected: [] });
  });

  it("(i) drops a root replaced by a symlink to a sibling", async () => {
    const roots = await prepared();
    await rm(path.join(base, "worktrees/cache"), { recursive: true });
    await symlink(path.join(base, "worktrees/other"), path.join(base, "worktrees/cache"));
    const result = await revalidateTrustedWriteRoots(roots, options());
    expect(result.roots).toEqual([]);
    expect(result.rejected[0]?.reason).toBe("not canonical (realpath differs)");
  });

  it("(ii) drops a root renamed away and recreated at the same path (new ino)", async () => {
    const roots = await prepared();
    await rename(path.join(base, "worktrees/cache"), path.join(base, "worktrees/cache-old"));
    await mkdir(path.join(base, "worktrees/cache"), { mode: 0o755 });
    await chmod(path.join(base, "worktrees/cache"), 0o755);
    const result = await revalidateTrustedWriteRoots(roots, options());
    expect(result.roots).toEqual([]);
    expect(result.rejected).toEqual([{ path: roots[0]!.path, reason: "identity changed" }]);
  });

  it("(iii) drops a root whose ancestor was replaced by a symlink", async () => {
    const roots = await prepared();
    await rename(path.join(base, "worktrees"), path.join(base, "worktrees-real"));
    await symlink(path.join(base, "worktrees-real"), path.join(base, "worktrees"));
    const result = await revalidateTrustedWriteRoots(roots, options());
    expect(result.roots).toEqual([]);
    expect(result.rejected[0]?.reason).toBe("not canonical (realpath differs)");
  });

  it("drops a root that disappeared", async () => {
    const roots = await prepared();
    await rm(path.join(base, "worktrees/cache"), { recursive: true });
    expect((await revalidateTrustedWriteRoots(roots, options())).rejected[0]?.reason).toBe("missing");
  });

  it.each(["EACCES", "EIO"])("drops a root whose entry lookup now fails with %s", async (code) => {
    const roots = await prepared();
    const fs: TrustedWriteRootFs = {
      ...fixtureFs(),
      lexists: async () => {
        throw Object.assign(new Error("lookup failed"), { code });
      },
    };
    expect(await revalidateTrustedWriteRoots(roots, { ...options(), fs })).toEqual({
      roots: [],
      rejected: [{ path: roots[0]!.path, reason: `cannot inspect .git (${code})` }],
    });
  });

  it.skipIf(uid === 0)("drops a root that lost search permission (real EACCES)", async () => {
    const roots = await prepared();
    const cache = path.join(base, "worktrees/cache");
    await chmod(cache, 0o600);
    try {
      expect((await revalidateTrustedWriteRoots(roots, options())).rejected).toEqual([
        { path: cache, reason: "cannot inspect .git (EACCES)" },
      ]);
    } finally {
      await chmod(cache, 0o755);
    }
  });
});

describe("trusted write-root context and helpers", () => {
  it("reads well-formed admissions and rejects malformed ones as a whole", () => {
    const ok = { path: "/x", ruleIndex: 0, issueId: "i" };
    expect(readTrustedWriteRootAdmissions({ trustedWriteRoots: [ok], trustedWriteRootsRulesHash: "0123456789ab" }))
      .toEqual({ admissions: [ok], rulesHash: "0123456789ab", malformed: false });
    expect(readTrustedWriteRootAdmissions({})).toEqual({ admissions: [], rulesHash: null, malformed: false });
    for (const bad of ["x", { path: "/x" }, [ok, { path: "/y", ruleIndex: -1, issueId: "i" }], [ok, null], [{ path: 1, ruleIndex: 0, issueId: "i" }]]) {
      expect(readTrustedWriteRootAdmissions({ trustedWriteRoots: bad })).toMatchObject({ admissions: [], malformed: true });
    }
    expect(readTrustedWriteRootAdmissions({ trustedWriteRoots: [], trustedWriteRootsRulesHash: "spoofed" }).rulesHash).toBeNull();
  });

  it("collects tmp, temp env vars and CODEX_CONFIG writable roots", () => {
    const roots = collectRunWritableRoots({
      paths: ["/w/cwd", "", "relative"],
      env: { TMPDIR: "/w/tmpdir", CODEX_CONFIG: JSON.stringify({ sandbox_workspace_write: { writable_roots: ["/w/extra"] } }) },
      hostEnv: { TMPDIR: "/w/host-tmp" },
    });
    expect(roots).toEqual(expect.arrayContaining(["/tmp", "/w/cwd", "/w/tmpdir", "/w/host-tmp", "/w/extra"]));
    expect(roots).not.toContain("relative");
  });

  it("matches path containment on component boundaries", () => {
    expect(isInsidePath("/a/b", "/a")).toBe(true);
    expect(isInsidePath("/a", "/a")).toBe(true);
    expect(isInsidePath("/ab", "/a")).toBe(false);
    expect(isInsidePath("/a/b", "/")).toBe(true);
  });

  it("formats the launch record", () => {
    expect(formatTrustedWriteRootsLaunchLine({
      roots: [{ path: "/r", dev: 1, ino: 2 }],
      admissions: [{ path: "/r", ruleIndex: 0, issueId: "issue" }],
      rulesHash: "0123456789ab",
      rejected: [],
    })).toBe('[paperclip] Codex trusted write roots: [{"path":"/r","dev":1,"ino":2}] admission=[{"issueId":"issue","ruleIndex":0}] rules=sha256:0123456789ab rejected=[]\n');
  });
});
