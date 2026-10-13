import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PluginLoader } from "../services/plugin-loader.js";

const registry = vi.hoisted(() => ({
  getById: vi.fn(), update: vi.fn(), updateStatus: vi.fn(),
}));
vi.mock("../services/plugin-registry.js", () => ({ pluginRegistryService: () => registry }));
import { pluginLifecycleManager } from "../services/plugin-lifecycle.js";
import { pluginLoader } from "../services/plugin-loader.js";

function manifest(capabilities: string[] = [], version = "1.0.0") {
  return { id: "example.plugin", apiVersion: 1, version, displayName: "Example",
    description: "Synthetic fixture", author: "Test", categories: ["ui"], capabilities,
    entrypoints: { worker: "worker.js" } };
}
function record() {
  return { id: "plugin-1", pluginKey: "example.plugin", status: "ready", version: "1.0.0",
    packageName: "example-plugin", packagePath: null, manifestJson: manifest() };
}
let current: ReturnType<typeof record>;
const dirs: string[] = [];
beforeEach(() => {
  vi.clearAllMocks(); current = record();
  registry.getById.mockImplementation(async () => current);
  registry.update.mockImplementation(async (_id, update) => {
    current = { ...current, version: update.version, manifestJson: update.manifest }; return current;
  });
  registry.updateStatus.mockImplementation(async (_id, update) => {
    current = { ...current, ...update }; return current;
  });
});
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixtureLoader(caps: string[]) {
  const newManifest = manifest(caps, "2.0.0");
  const runtime = { running: true, tools: true, capabilities: [] as string[] };
  const loader = {
    hasRuntimeServices: () => true,
    upgradePlugin: vi.fn(async () => {
      const oldManifest = current.manifestJson;
      await registry.update(current.id, { version: "2.0.0", manifest: newManifest });
      return { oldManifest, newManifest, discovered: { version: "2.0.0" } };
    }),
    unloadSingle: vi.fn(async () => { runtime.running = false; runtime.tools = false; }),
    loadSingle: vi.fn(async () => {
      runtime.running = true; runtime.tools = true; runtime.capabilities = current.manifestJson.capabilities;
      return { success: true, plugin: current };
    }),
  };
  return { runtime, loader, lifecycle: pluginLifecycleManager({} as never, { loader: loader as unknown as PluginLoader }) };
}

describe("plugin upgrade approval and runtime continuity", () => {
  it("persists escalating upgrades as pending and activates capabilities only after enable", async () => {
    const { lifecycle, runtime, loader } = fixtureLoader(["companies.read"]);
    const pending = await lifecycle.upgrade(current.id);
    expect(pending).toMatchObject({ status: "upgrade_pending", version: "2.0.0" });
    expect(pending.manifestJson.capabilities).toEqual(["companies.read"]);
    expect(runtime).toMatchObject({ running: false, tools: false, capabilities: [] });
    expect(loader.loadSingle).not.toHaveBeenCalled();
    await lifecycle.enable(current.id);
    expect(current.status).toBe("ready");
    expect(runtime).toEqual({ running: true, tools: true, capabilities: ["companies.read"] });
  });
  it("keeps repeated pending upgrades behind the enable approval gate", async () => {
    const { lifecycle, loader } = fixtureLoader(["companies.read"]);
    await lifecycle.upgrade(current.id);
    await lifecycle.upgrade(current.id);
    expect(current.status).toBe("upgrade_pending");
    expect(loader.loadSingle).not.toHaveBeenCalled();
  });
  it("leaves the existing worker and tools untouched when validation fails", async () => {
    const { lifecycle, runtime, loader } = fixtureLoader([]);
    loader.upgradePlugin.mockRejectedValueOnce(new Error("invalid manifest"));
    await expect(lifecycle.upgrade(current.id)).rejects.toThrow("invalid manifest");
    expect(loader.unloadSingle).not.toHaveBeenCalled();
    expect(runtime).toMatchObject({ running: true, tools: true });
    expect(current).toEqual(record());
  });
  it("activates non-escalating upgrades immediately after validation", async () => {
    const { lifecycle, runtime, loader } = fixtureLoader([]);
    await lifecycle.upgrade(current.id);
    expect(current).toMatchObject({ status: "ready", version: "2.0.0" });
    expect(runtime).toMatchObject({ running: true, tools: true });
    expect(loader.upgradePlugin.mock.invocationCallOrder[0]).toBeLessThan(loader.unloadSingle.mock.invocationCallOrder[0]!);
  });
  it("the real loader returns and persists a validated capability escalation", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "plugin-upgrade-")); dirs.push(dir);
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "example-plugin", version: "2.0.0", type: "module", paperclipPlugin: { manifest: "manifest.js" } }));
    writeFileSync(path.join(dir, "manifest.js"), `export default ${JSON.stringify(manifest(["companies.read"], "2.0.0"))};`);
    writeFileSync(path.join(dir, "worker.js"), "export default {};\n");
    const loader = pluginLoader({} as never, { localPluginDir: dir });
    const result = await loader.upgradePlugin(current.id, { localPath: dir });
    expect(result.oldManifest.capabilities).toEqual([]);
    expect(result.newManifest.capabilities).toEqual(["companies.read"]);
    expect(current.version).toBe("2.0.0");
  });
});
