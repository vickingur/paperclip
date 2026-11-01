// §4.5 synthetic enforcement check for trusted write roots, on the vendored
// Codex 0.160.0 Linux sandbox (`codex sandbox`, bwrap: a read-only bind of `/`
// plus one read-write bind per writable root).
//
// It builds a disposable base `B` under the OS temp dir with the same shape as
// the real cache (`B/worktrees/fx-root` beside `B/projects/nk`), grants only
// `fx-root` and a scratch dir, excludes `/tmp` and `$TMPDIR` from the writable
// set so `B`'s parents are read-only in the namespace, and checks from inside:
//   * a write in the granted root succeeds; writes into the sibling, through
//     `..` and through an internal symlink fail (EROFS) and leave no file;
//   * the §3.4(3) mount assumptions: the root and each ancestor (`B/worktrees`,
//     `B`) cannot be renamed, removed or replaced by a symlink, while cwd and
//     scratch stay writable.
// This proves sandbox behaviour for a synthetic grant only. It is NOT the live
// §4.6 qualification on the deployed ACPX path, which stays UNQUALIFIED until a
// separately authorized run.
//
// Skips, with the reason, when the sandbox cannot start here (for example a CI
// runner without unprivileged user namespaces) or when
// PAPERCLIP_SKIP_CODEX_SANDBOX_QUALIFICATION=1.
//
//   node --test scripts/codex-trusted-write-root-sandbox.test.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

const require = createRequire(new URL("../packages/paperclip-runner/package.json", import.meta.url));

function codexBin() {
  try {
    return join(dirname(require.resolve("@openai/codex/package.json")), "bin/codex.js");
  } catch {
    return null;
  }
}

function sandboxRun({ codex, cwd, home, writableRoots, scratch, script }) {
  const args = [
    codex, "sandbox",
    "-c", 'sandbox_mode="workspace-write"',
    "-c", `sandbox_workspace_write.writable_roots=${JSON.stringify(writableRoots)}`,
    "-c", "sandbox_workspace_write.exclude_slash_tmp=true",
    "-c", "sandbox_workspace_write.exclude_tmpdir_env_var=true",
    "-c", "sandbox_workspace_write.network_access=false",
    "--", "sh", "-c", script,
  ];
  return spawnSync(process.execPath, args, {
    cwd,
    encoding: "utf8",
    timeout: 60_000,
    env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: join(home, ".codex"), TMPDIR: scratch, LANG: "C" },
  });
}

function skipReason(codex, layout) {
  if (process.env.PAPERCLIP_SKIP_CODEX_SANDBOX_QUALIFICATION === "1") return "PAPERCLIP_SKIP_CODEX_SANDBOX_QUALIFICATION=1";
  if (process.platform !== "linux") return `codex sandbox linux qualification needs Linux (platform ${process.platform})`;
  if (!codex) return "@openai/codex is not installed";
  const probe = sandboxRun({ codex, ...layout, script: "touch probe-ok" });
  if (probe.status !== 0 || !existsSync(join(layout.cwd, "probe-ok"))) {
    return `codex sandbox cannot start here (exit ${probe.status}): ${(probe.stderr || probe.error?.message || "").trim().split("\n").slice(-1)[0]}`;
  }
  return null;
}

function setupLayout() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "paperclip-fx-")));
  const layout = {
    base,
    cwd: join(base, "projects/nk"),
    root: join(base, "worktrees/fx-root"),
    sibling: join(base, "worktrees/fx-sibling"),
    scratch: join(base, "scratch"),
    home: join(base, "home"),
  };
  for (const dir of [layout.cwd, layout.root, layout.sibling, layout.scratch, join(layout.home, ".codex")]) mkdirSync(dir, { recursive: true });
  return layout;
}

const layout = setupLayout();
const codex = codexBin();
const reason = skipReason(codex, { cwd: layout.cwd, home: layout.home, writableRoots: [layout.root, layout.scratch], scratch: layout.scratch });
test.after(() => rmSync(layout.base, { recursive: true, force: true }));

// Each row prints `<name> <exit> <stderr>`, so one sandbox start covers all rows.
function rows(commands) {
  return commands.map(([name, command]) => `out=$( { ${command} ; } 2>&1 ); echo "${name} $? $out"`).join("\n");
}

function parse(stdout) {
  return Object.fromEntries(stdout.trim().split("\n").filter(Boolean).map((line) => {
    const [name, exit, ...rest] = line.split(" ");
    return [name, { exit: Number(exit), message: rest.join(" ") }];
  }));
}

test("granted root is writable and escapes are denied (§4.5)", { skip: reason ?? false }, () => {
  const { root, sibling, base, cwd, scratch, home } = layout;
  const result = sandboxRun({
    codex, cwd, home, scratch, writableRoots: [root, scratch],
    script: rows([
      ["write_root", `touch ${root}/ok`],
      ["write_sibling", `touch ${sibling}/x`],
      ["write_dotdot", `touch ${root}/../fx-sibling/y`],
      ["make_internal_symlink", `ln -s ../fx-sibling ${root}/esc`],
      ["write_through_symlink", `touch ${root}/esc/z`],
      ["write_cwd", `touch ${cwd}/cwd-ok`],
      ["write_scratch", `touch ${scratch}/scratch-ok`],
      ["write_base", `touch ${base}/base-x`],
    ]),
  });
  assert.equal(result.status, 0, result.stderr);
  const out = parse(result.stdout);
  assert.equal(out.write_root.exit, 0);
  assert.equal(out.make_internal_symlink.exit, 0, "a symlink inside the granted root is an ordinary write");
  for (const row of ["write_sibling", "write_dotdot", "write_through_symlink", "write_base"]) {
    assert.notEqual(out[row].exit, 0, `${row} must fail`);
    assert.match(out[row].message, /Read-only file system/, `${row}: ${out[row].message}`);
  }
  assert.equal(out.write_cwd.exit, 0);
  assert.equal(out.write_scratch.exit, 0);
  assert.equal(existsSync(join(root, "ok")), true);
  for (const absent of [join(sibling, "x"), join(sibling, "y"), join(sibling, "z"), join(base, "base-x")]) {
    assert.equal(existsSync(absent), false, `${absent} must not exist`);
  }
});

test("the root and its ancestors cannot be renamed, removed or replaced from the namespace (§4.2c)", { skip: reason ?? false }, () => {
  const { root, base, cwd, scratch, home } = layout;
  const worktrees = dirname(root);
  const before = Object.fromEntries([root, worktrees, base].map((p) => [p, lstatSync(p).ino]));
  const commands = [];
  for (const [label, target] of [["root", root], ["worktrees", worktrees], ["base", base]]) {
    commands.push([`mv_${label}`, `mv ${target} ${target}-moved`]);
    commands.push([`rmdir_${label}`, `rmdir ${target}`]);
    // -T: treat the target as the entry to replace, not a directory to link into.
    // ln refuses to unlink a directory itself; the rmdir and mv rows are the
    // kernel-level proof that the entry cannot be removed or renamed.
    commands.push([`symlink_${label}`, `ln -sfnT ${scratch} ${target}`]);
  }
  commands.push(["write_cwd_after", `touch ${cwd}/after-ok`]);
  commands.push(["write_scratch_after", `touch ${scratch}/after-ok`]);
  const result = sandboxRun({ codex, cwd, home, scratch, writableRoots: [root, scratch], script: rows(commands) });
  assert.equal(result.status, 0, result.stderr);
  const out = parse(result.stdout);
  if (process.env.PAPERCLIP_SANDBOX_QUALIFICATION_VERBOSE === "1") console.log(result.stdout);
  for (const label of ["root", "worktrees", "base"]) {
    for (const op of ["mv", "rmdir", "symlink"]) {
      const row = out[`${op}_${label}`];
      assert.notEqual(row.exit, 0, `${op} ${label} must fail: ${row.message}`);
      const expected = op === "symlink" ? /Read-only file system|cannot overwrite directory/ : /Read-only file system|Device or resource busy/;
      assert.match(row.message, expected, `${op} ${label}: ${row.message}`);
    }
  }
  assert.equal(out.write_cwd_after.exit, 0);
  assert.equal(out.write_scratch_after.exit, 0);
  // Codex mounts read-only `.git`/`.agents`/`.codex` targets inside each
  // writable root only inside the namespace; none may remain on the host, or
  // the engine's next validation would (correctly) reject the root.
  for (const entry of [".git", ".agents", ".codex"]) {
    assert.equal(existsSync(join(root, entry)), false, `${entry} must not remain in the root`);
  }
  // Nothing in the chain was replaced: same inodes, no symlinks.
  for (const [p, ino] of Object.entries(before)) {
    const stat = lstatSync(p);
    assert.equal(stat.isSymbolicLink(), false, `${p} must not be a symlink`);
    assert.equal(stat.ino, ino, `${p} keeps its inode`);
  }
});

if (reason) console.log(`# SKIP codex sandbox qualification: ${reason}`);
