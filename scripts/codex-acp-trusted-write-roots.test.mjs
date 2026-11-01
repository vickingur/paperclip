import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs, { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";

// Loads the installed, patched codex-acp dist and drives its real turn
// boundary (`sendPrompt`) with a fake Codex client, so the asserted policy is
// the object codex-acp would send in `turn/start`. Roots are temp directories
// of this test only; nothing is granted to any real process.

const require = createRequire(new URL("../packages/paperclip-runner/package.json", import.meta.url));
const source = fs.readFileSync(require.resolve("@agentclientprotocol/codex-acp"), "utf8");
const helperStart = source.indexOf("function paperclipSandboxPolicy(");
const helperEnd = source.indexOf("\nvar CodexAcpClient", helperStart);
const methodStart = source.indexOf("  async sendPrompt(");
const methodEnd = source.indexOf("\n  async runAgentFileChangeReport", methodStart);
assert.ok(helperStart >= 0 && helperEnd > helperStart, "installed Codex ACP must contain the Paperclip sandbox policy patch");
assert.ok(source.slice(helperStart, helperEnd).includes("function paperclipTrustedWriteRoots("), "patch must carry the trusted write-root channel");
assert.ok(methodStart >= 0 && methodEnd > methodStart, "installed Codex ACP must expose the patched turn boundary");

async function turn(policy, env) {
  const stderr = [];
  const context = {
    process: { env, stderr: { write: (chunk) => { stderr.push(String(chunk)); return true; } } },
    require,
    fs7: fs,
    path6: path,
    uniqueStrings: (values) => Array.from(new Set(values)),
    buildPromptItems: (prompt) => prompt,
    addAdditionalDirectoriesToSandboxPolicy: (value) => value,
  };
  const client = runInNewContext(
    source.slice(helperStart, helperEnd) + "\n({" + source.slice(methodStart, methodEnd) + "})",
    context,
  );
  client.refreshSkills = async () => {};
  client.codexClient = { runTurn: async (params) => params };
  const params = await client.sendPrompt(
    { sessionId: "thread", prompt: [] },
    { approvalPolicy: "on-request", sandboxPolicy: policy },
    { model: "test-model", effort: "low" },
    null, false, "/workspace", [], undefined, undefined,
  );
  return { policy: params.sandboxPolicy, stderr };
}

function fixture(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "paperclip-codex-trusted-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, "root");
  const sibling = join(base, "sibling");
  mkdirSync(root);
  mkdirSync(sibling);
  const identity = (p) => { const s = lstatSync(p); return { path: p, dev: s.dev, ino: s.ino }; };
  return { base, root, sibling, identity };
}

const workspacePolicy = () => ({ type: "workspaceWrite", writableRoots: ["/workspace"], networkAccess: false });

test("extends workspaceWrite with launch-identical trusted roots and keeps network semantics", async (t) => {
  const { root, identity } = fixture(t);
  const env = { PAPERCLIP_CODEX_ACP_TRUSTED_WRITE_ROOTS: JSON.stringify([identity(root)]) };
  const policy = workspacePolicy();
  const result = await turn(policy, env);
  assert.deepEqual(result.policy.writableRoots, ["/workspace", root]);
  assert.equal(result.policy.type, "workspaceWrite");
  assert.equal(result.policy.networkAccess, false, "no network override keeps the preset value");
  assert.deepEqual(policy.writableRoots, ["/workspace"], "must not mutate the shared mode preset");
  for (const [networkEnv, expected] of [
    [{ PAPERCLIP_CODEX_ACP_NETWORK_ACCESS: "true" }, true],
    [{ PAPERCLIP_CODEX_ACP_NETWORK_ACCESS: "false" }, false],
    [{ PAPERCLIP_CODEX_ACP_NETWORK_ACCESS: "true", PAPERCLIP_RUNNER_NETWORK_ACCESS: "disabled" }, false],
  ]) {
    const withNetwork = await turn({ ...policy, networkAccess: !expected }, { ...env, ...networkEnv });
    assert.equal(withNetwork.policy.networkAccess, expected);
    assert.deepEqual(withNetwork.policy.writableRoots, ["/workspace", root]);
  }
});

test("records the effective turn policy that is sent", async (t) => {
  const { root, identity } = fixture(t);
  const result = await turn(workspacePolicy(), {
    PAPERCLIP_CODEX_ACP_TRUSTED_WRITE_ROOTS: JSON.stringify([identity(root)]),
    PAPERCLIP_CODEX_ACP_NETWORK_ACCESS: "true",
  });
  const hash = createHash("sha256").update(JSON.stringify(result.policy)).digest("hex").slice(0, 12);
  assert.deepEqual(result.stderr, [
    `[paperclip] turn sandboxPolicy sha256:${hash} type=workspaceWrite writableRoots=${JSON.stringify(["/workspace", root])} networkAccess=true\n`,
  ]);
});

test("leaves readOnly and full-access policies untouched", async (t) => {
  const { root, identity } = fixture(t);
  const env = { PAPERCLIP_CODEX_ACP_TRUSTED_WRITE_ROOTS: JSON.stringify([identity(root)]), PAPERCLIP_CODEX_ACP_NETWORK_ACCESS: "true" };
  for (const policy of [{ type: "readOnly", networkAccess: false }, { type: "dangerFullAccess" }]) {
    assert.equal((await turn(policy, env)).policy, policy);
  }
});

test("keeps the exact policy object when no root and no network override apply", async () => {
  const policy = workspacePolicy();
  for (const value of [undefined, "", "[]"]) {
    assert.equal((await turn(policy, { PAPERCLIP_CODEX_ACP_TRUSTED_WRITE_ROOTS: value })).policy, policy);
  }
});

test("ignores malformed, relative and unnormalized entries", async (t) => {
  const { root, identity } = fixture(t);
  const policy = workspacePolicy();
  for (const [value, line] of [
    ["{", "[paperclip] trusted write roots ignored: malformed JSON\n"],
    [JSON.stringify({ path: root }), "[paperclip] trusted write roots ignored: not an array\n"],
    [JSON.stringify([{ ...identity(root), path: "relative/root" }]), "[paperclip] trusted write root dropped: \"relative/root\" (malformed)\n"],
    [JSON.stringify([{ ...identity(root), path: `${root}/../root` }]), `[paperclip] trusted write root dropped: ${JSON.stringify(`${root}/../root`)} (malformed)\n`],
    [JSON.stringify([{ path: root }]), `[paperclip] trusted write root dropped: ${JSON.stringify(root)} (malformed)\n`],
  ]) {
    const result = await turn(policy, { PAPERCLIP_CODEX_ACP_TRUSTED_WRITE_ROOTS: value });
    assert.equal(result.policy, policy, `policy unchanged for ${value}`);
    assert.equal(result.stderr[0], line);
  }
});

test("drops a root whose identity changed or that was replaced since launch", async (t) => {
  const { base, root, sibling, identity } = fixture(t);
  const launched = identity(root);
  const env = { PAPERCLIP_CODEX_ACP_TRUSTED_WRITE_ROOTS: JSON.stringify([launched]) };
  // Same path, new inode.
  rmSync(root, { recursive: true });
  mkdirSync(root);
  let result = await turn(workspacePolicy(), env);
  assert.deepEqual(result.policy.writableRoots, ["/workspace"]);
  assert.equal(result.stderr[0], `[paperclip] trusted write root dropped: ${root} (identity changed)\n`);
  // Replaced by a symlink to a sibling.
  rmSync(root, { recursive: true });
  symlinkSync(sibling, root, "dir");
  result = await turn(workspacePolicy(), env);
  assert.deepEqual(result.policy.writableRoots, ["/workspace"]);
  assert.equal(result.stderr[0], `[paperclip] trusted write root dropped: ${root} (not a canonical directory)\n`);
  // Removed.
  rmSync(root);
  result = await turn(workspacePolicy(), env);
  assert.equal(result.stderr[0], `[paperclip] trusted write root dropped: ${root} (missing)\n`);
  // Ancestor replaced by a symlink: the path no longer resolves canonically.
  const moved = join(base, "..", `${path.basename(base)}-moved`);
  t.after(() => rmSync(moved, { recursive: true, force: true }));
  mkdirSync(join(base, "nested", "root"), { recursive: true });
  const nested = identity(join(base, "nested", "root"));
  fs.renameSync(join(base, "nested"), moved);
  symlinkSync(moved, join(base, "nested"), "dir");
  result = await turn(workspacePolicy(), { PAPERCLIP_CODEX_ACP_TRUSTED_WRITE_ROOTS: JSON.stringify([nested]) });
  assert.deepEqual(result.policy.writableRoots, ["/workspace"]);
  assert.equal(result.stderr[0], `[paperclip] trusted write root dropped: ${nested.path} (not a canonical directory)\n`);
});
