import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, issues, projects, projectWorkspaces } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { heartbeatService } from "../services/heartbeat.ts";

// Server-owned propagation of trusted write roots: the adapter receives the
// admissions resolved from the deploy env and the same-company DB issue, and a
// wake context can never supply or widen them. Synthetic data only; no
// filesystem grant is exercised here (the engine validates paths).

const execute = vi.hoisted(() => vi.fn(async (_input: any) => ({ exitCode: 0, signal: null, timedOut: false })));
vi.mock("../adapters/index.js", () => ({
  getServerAdapter: () => ({ type: "codex_local", execute, supportsLocalAgentJwt: false }),
  findActiveServerAdapter: () => ({ type: "codex_local", execute, supportsLocalAgentJwt: false }),
  runningProcesses: new Map(),
}));

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping embedded Postgres trusted write-root tests on this host: ${support.reason ?? "unsupported environment"}`);
}

const FIXTURE_ROOT = "/paperclip/worktrees/vik-2207-fx-root";

suite("heartbeat trusted write-root propagation", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "paperclip-trusted-roots-"));
    vi.stubEnv("PAPERCLIP_HOME", path.join(root, "home"));
    database = await startEmbeddedPostgresTestDatabase("trusted-write-roots");
    db = createDb(database.connectionString);
    heartbeat = heartbeatService(db);
    execute.mockImplementation(async (input) => {
      if (typeof input.context.issueId === "string") {
        await db.update(issues).set({ status: "done" }).where(eq(issues.id, input.context.issueId));
      }
      return { exitCode: 0, signal: null, timedOut: false };
    });
  }, 30_000);
  afterEach(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    vi.stubEnv("PAPERCLIP_TRUSTED_WRITE_ROOTS", undefined as unknown as string);
  });
  afterAll(async () => {
    if (db && heartbeat) await drainHeartbeatRunsToQuiescence(db, heartbeat);
    await db?.$client.end({ timeout: 5 });
    await database?.cleanup();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }, 60_000);

  async function seed() {
    const companyId = randomUUID(), otherCompanyId = randomUUID(), projectId = randomUUID(), agentId = randomUUID();
    const issueId = randomUUID(), unrelatedIssueId = randomUUID(), planningIssueId = randomUUID(), foreignIssueId = randomUUID();
    const otherProjectId = randomUUID();
    for (const id of [companyId, otherCompanyId]) {
      await db.insert(companies).values({ id, name: "Synthetic", issuePrefix: `T${id.slice(0, 6)}`, defaultResponsibleUserId: "responsible-user" });
    }
    const cwd = path.join(root, companyId, "project");
    await mkdir(cwd, { recursive: true });
    await writeFile(path.join(cwd, "README.md"), "synthetic\n");
    const git = (...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });
    git("init", "-b", "main");
    git("add", ".");
    git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "seed");
    await db.insert(projects).values({ id: projectId, companyId, name: "Synthetic project" });
    await db.insert(projects).values({ id: otherProjectId, companyId: otherCompanyId, name: "Foreign project" });
    await db.insert(projectWorkspaces).values({ id: randomUUID(), companyId, projectId, name: "Primary", sourceType: "local_path", cwd, isPrimary: true });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Synthetic Codex", role: "engineer", status: "idle", adapterType: "codex_local",
      // A synthetic placeholder satisfies the codex_local pre-dispatch credential
      // gate; the adapter is mocked, so nothing uses it.
      adapterConfig: { env: { OPENAI_API_KEY: "synthetic-placeholder" } }, runtimeConfig: {}, permissions: {},
    });
    for (const [id, workMode] of [[issueId, "standard"], [unrelatedIssueId, "standard"], [planningIssueId, "planning"]] as const) {
      await db.insert(issues).values({ id, companyId, projectId, title: "Synthetic task", status: "todo", assigneeAgentId: agentId, workMode });
    }
    await db.insert(issues).values({ id: foreignIssueId, companyId: otherCompanyId, projectId: otherProjectId, title: "Foreign task", status: "todo" });
    vi.stubEnv("PAPERCLIP_TRUSTED_WRITE_ROOTS", JSON.stringify([{
      path: FIXTURE_ROOT, companyId, projectId, issueIds: [issueId], workModes: ["standard"], agentIds: [agentId], adapterTypes: ["codex_local"],
    }]));
    return { companyId, projectId, agentId, issueId, unrelatedIssueId, planningIssueId, foreignIssueId };
  }

  async function runAndCapture(agentId: string, contextSnapshot: Record<string, unknown>) {
    const run = await heartbeat.wakeup(agentId, { source: "on_demand", triggerDetail: "manual", contextSnapshot });
    expect(run).not.toBeNull();
    await vi.waitFor(async () => {
      const latest = await heartbeat.getRun(run!.id);
      expect(["succeeded", "failed", "cancelled"]).toContain(latest?.status);
    }, { timeout: 15_000 });
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    const call = execute.mock.calls.find(([input]) => input.runId === run!.id);
    const latest = await heartbeat.getRun(run!.id);
    expect({ status: latest?.status, error: latest?.error, called: Boolean(call) }).toEqual({ status: "succeeded", error: null, called: true });
    return call?.[0]?.context?.paperclipWorkspace as Record<string, unknown> | undefined;
  }

  it("admits the exact issue and overwrites spoofed workspace fields", async () => {
    const seeded = await seed();
    const workspace = await runAndCapture(seeded.agentId, {
      issueId: seeded.issueId,
      projectId: seeded.projectId,
      // Spoofed values must be replaced by the server-built literal.
      paperclipWorkspace: { trustedWriteRoots: [{ path: "/", ruleIndex: 0, issueId: seeded.issueId }], trustedWriteRootsRulesHash: "000000000000" },
    });
    expect(workspace?.projectId).toBe(seeded.projectId);
    expect(workspace?.trustedWriteRoots).toEqual([{ path: FIXTURE_ROOT, ruleIndex: 0, issueId: seeded.issueId }]);
    expect(workspace?.trustedWriteRootsRulesHash).toMatch(/^[0-9a-f]{12}$/);
    expect(workspace?.trustedWriteRootsRulesHash).not.toBe("000000000000");
  }, 30_000);

  it("denies unrelated, planning, taskless and spoofed wakes", async () => {
    const seeded = await seed();
    const spoof = { paperclipWorkspace: { trustedWriteRoots: [{ path: FIXTURE_ROOT, ruleIndex: 0, issueId: seeded.issueId }] } };
    // (b) unrelated standard issue in the same project, same agent, spoofed roots.
    expect((await runAndCapture(seeded.agentId, { issueId: seeded.unrelatedIssueId, projectId: seeded.projectId, ...spoof }))?.trustedWriteRoots).toEqual([]);
    // (h) planning mode on an otherwise matching issue, with a spoofed mode.
    await db.update(issues).set({ status: "todo", workMode: "planning" }).where(eq(issues.id, seeded.issueId));
    expect((await runAndCapture(seeded.agentId, { issueId: seeded.issueId, projectId: seeded.projectId, workMode: "standard", ...spoof }))?.trustedWriteRoots).toEqual([]);
    // (f) a wake naming another company's issue is refused before any run is
    // queued, so no adapter call (and no admission) exists for it.
    const callsBefore = execute.mock.calls.length;
    expect(await heartbeat.wakeup(seeded.agentId, { source: "on_demand", triggerDetail: "manual",
      contextSnapshot: { issueId: seeded.foreignIssueId, projectId: seeded.projectId, ...spoof } })).toBeNull();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    expect(execute.mock.calls.length).toBe(callsBefore);
    // (c) taskless with the rule project in context.
    expect((await runAndCapture(seeded.agentId, { projectId: seeded.projectId, ...spoof }))?.trustedWriteRoots ?? []).toEqual([]);
  }, 60_000);

  it("grants nothing when the deploy env is absent or malformed", async () => {
    const seeded = await seed();
    vi.stubEnv("PAPERCLIP_TRUSTED_WRITE_ROOTS", "{not json");
    const malformed = await runAndCapture(seeded.agentId, { issueId: seeded.issueId, projectId: seeded.projectId });
    expect(malformed?.trustedWriteRoots).toEqual([]);
    expect(malformed?.trustedWriteRootsRulesHash).toBeNull();
    await db.update(issues).set({ status: "todo" }).where(eq(issues.id, seeded.issueId));
    vi.stubEnv("PAPERCLIP_TRUSTED_WRITE_ROOTS", undefined as unknown as string);
    const absent = await runAndCapture(seeded.agentId, { issueId: seeded.issueId, projectId: seeded.projectId });
    expect(absent?.trustedWriteRoots).toEqual([]);
    expect(absent?.trustedWriteRootsRulesHash).toBeNull();
  }, 60_000);
});
