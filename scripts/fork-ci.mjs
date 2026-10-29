import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, appendFileSync } from "node:fs";

const lanes = JSON.parse(readFileSync("scripts/fork-ci-lanes.json", "utf8"));
const env = { ...process.env, GITHUB_WORKFLOW: "Fork exact-head CI" };
function run(command, args, capture = false) {
  const result = spawnSync(command, args, { env, encoding: "utf8", stdio: capture ? "pipe" : "inherit", maxBuffer: 32 * 1024 * 1024 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr || `${command} ${args.join(" ")} failed`);
  return result.stdout;
}
function plan(args) {
  return JSON.parse(run(process.execPath, ["scripts/run-vitest-stable.mjs", ...args, "--dry-run"], true));
}
function exact(actual, expected, label) {
  assert.ok(actual.length > 0, `${label}: empty coverage`);
  assert.equal(new Set(actual).size, actual.length, `${label}: duplicate coverage`);
  assert.deepEqual([...actual].sort(), [...expected].sort(), `${label}: missing or extra coverage`);
}
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? walk(`${dir}/${entry.name}`) : [`${dir}/${entry.name}`]);
}
export function verify(candidate = lanes) {
  exact(candidate.map(lane => lane.id), lanes.map(lane => lane.id), "lane IDs");
  const expected = plan(["--mode", "general", "--group", "general-server", "--shard-index", "0", "--shard-count", "1"]);
  const manifest = candidate.map(lane => ({ ...lane, selection: plan(lane.args) }));
  for (const { id, selection: p } of manifest) {
    const files = p.mode === "serialized" ? p.selectedSerializedSuites : p.selectedGeneralServerSuites;
    if (files) assert.ok(files.length > 0, `${id}: empty lane`);
  }
  const server = manifest.flatMap(({ selection: p }) => p.mode === "serialized" ? p.selectedSerializedSuites : p.selectedGeneralServerSuites ?? []);
  // Mirror server/vitest.config.ts, independently of the stable runner's partition.
  const discovered = [...walk("server/src").filter(p => p.endsWith(".test.ts")), ...walk("server/scripts").filter(p => p.endsWith(".test.mjs"))];
  exact(server, discovered, "server suites");
  exact(server, [...expected.selectedGeneralServerSuites, ...expected.selectedSerializedSuites], "stable server lanes");
  const projects = new Map();
  for (const { selection: p } of manifest) for (const project of p.workspaceProjects ?? []) {
    const slices = projects.get(project) ?? [];
    slices.push(p.workspacesVitestShard ?? "1/1"); projects.set(project, slices);
  }
  const config = readFileSync("vitest.config.ts", "utf8");
  const configured = [...config.matchAll(/^      "([^\"]+)",?$/gm)].map(m => m[1]).filter(p => p !== "server").map(p => JSON.parse(readFileSync(`${p}/package.json`, "utf8")).name);
  exact([...projects.keys()], configured, "workspace projects");
  for (const [project, slices] of projects) {
    const count = Number(slices[0].split("/")[1]);
    exact(slices, Array.from({ length: count }, (_, i) => `${i + 1}/${count}`), project);
  }
  return manifest;
}
const command = process.argv[2];
if (command === "manifest") {
  const manifest = verify();
  console.log(JSON.stringify(manifest, null, 2));
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `matrix=${JSON.stringify({ include: lanes.map(({ id }) => ({ id })) })}\n`);
} else if (command === "run") {
  verify();
  const lane = lanes.find(l => l.id === process.argv[3]);
  assert.ok(lane, "Unknown lane");
  run("pnpm", ["run", "preflight:workspace-links"]);
  run("pnpm", ["--filter", "@paperclipai/plugin-sdk", "ensure-build-deps"]);
  if (lane.args.includes("general-server")) {
    // Recovery suites otherwise skip when release binaries are absent.
    run("pnpm", ["--filter", "@paperclipai/paperclip-runner", "build:binary"]);
    run("pnpm", ["--filter", "@paperclipai/paperclip-runner", "build:runner-binaries"]);
  }
  run(process.execPath, ["scripts/run-vitest-stable.mjs", ...lane.args]);
} else if (command !== undefined) throw new Error("Expected manifest or run <lane>");
