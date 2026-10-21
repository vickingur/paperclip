import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { resetRuntimeServicesForTests, startRuntimeServicesForWorkspaceControl } from "../services/workspace-runtime.js";
import {
  findAdoptableLocalService,
  readLocalServicePortOwner,
  readLocalServiceProcessGroupId,
  terminateLocalService,
} from "../services/local-service-supervisor.js";

it.skipIf(process.platform !== "linux")("adopts and stops an unregistered listener without ps or lsof, preserving foreign cwd listeners", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-linux-orphan-"));
  const previousHome = process.env.PAPERCLIP_HOME;
  const previousPath = process.env.PATH;
  process.env.PAPERCLIP_HOME = root;
  const workspace = path.join(root, "workspace");
  const foreign = path.join(root, "foreign");
  await fs.mkdir(workspace);
  await fs.mkdir(foreign);
  const script = path.join(workspace, "server.cjs");
  await fs.writeFile(script, "require('node:http').createServer((q,s)=>s.end('fixture')).listen(0,'127.0.0.1',function(){console.log(this.address().port)})");
  const child = spawn(process.execPath, [script], { cwd: workspace, detached: true, stdio: ["ignore", "pipe", "inherit"] });
  let exited = false;
  child.on("exit", () => { exited = true; });
  try {
    const [chunk] = await once(child.stdout!, "data");
    const port = Number(String(chunk).trim());
    expect(port).toBeGreaterThan(0);
    // Neither tool exists in this PATH, as in the Framework production image.
    process.env.PATH = root;
    expect(await readLocalServicePortOwner(port)).toBe(child.pid);
    expect(await readLocalServiceProcessGroupId(child.pid!)).toBe(child.pid);
    const input = {
      serviceKey: "linux-orphan-fixture",
      serviceName: "fixture",
      command: `${process.execPath} ${script}`,
      cwd: foreign,
      envFingerprint: "synthetic",
      port,
      url: `http://127.0.0.1:${port}`,
    };
    expect(await findAdoptableLocalService(input)).toBeNull();
    expect((await fetch(input.url)).ok).toBe(true);
    expect(await findAdoptableLocalService({ ...input, cwd: workspace, command: "node unrelated-server.cjs" })).toBeNull();
    const adopted = await findAdoptableLocalService({ ...input, cwd: workspace });
    expect(adopted?.pid).toBe(child.pid);
    // Managed start after stop/restart must adopt, not spawn on the busy port.
    const [managed] = await startRuntimeServicesForWorkspaceControl({
      actor: { id: null, name: "Board", companyId: "00000000-0000-4000-8000-000000000001" },
      issue: null,
      workspace: {
        baseCwd: workspace, cwd: workspace, source: "agent_home", strategy: "project_primary",
        projectId: null, workspaceId: null, repoUrl: null, repoRef: null,
        branchName: null, worktreePath: null, warnings: [], created: false,
      },
      config: { workspaceRuntime: { services: [{
        name: "fixture", command: input.command,
        port: { type: "fixed", value: port },
        readiness: { type: "http", urlTemplate: input.url, timeoutSec: 5, intervalMs: 100 },
        lifecycle: "shared", reuseScope: "agent", stopPolicy: { type: "manual" },
      }] } },
      adapterEnv: {},
    });
    expect(managed?.providerRef).toBe(String(child.pid));
    expect(managed?.reused).toBe(true);
    await resetRuntimeServicesForTests({ terminateProcesses: true });
    expect(await readLocalServicePortOwner(port)).toBeNull();
    await expect(fetch(input.url)).rejects.toThrow();
  } finally {
    await resetRuntimeServicesForTests({ terminateProcesses: true });
    if (!exited) await terminateLocalService({ pid: child.pid!, processGroupId: child.pid! });
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = previousHome;
    await fs.rm(root, { recursive: true, force: true });
  }
});
