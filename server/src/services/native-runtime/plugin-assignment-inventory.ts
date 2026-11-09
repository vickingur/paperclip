import { heartbeatRuns, type Db } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { getAssignedMcpGateway } from "./assigned-mcp-tools.js";
import { createPinnedToolAssignment, pinnedToolAssignmentDigest } from "./pinned-tool-assignment.js";

/**
 * Capture through the configured server gateway, including authoritative run
 * context. This inventory is a ceiling, never an authorization grant. Persist
 * the returned assignment before realization; never recapture it in tools/list.
 */
export async function resolvePluginAssignmentInventory(
  db: Db,
  binding: { companyId: string; agentId: string; runId: string },
) {
  const descriptors = await getAssignedMcpGateway(db).listPluginToolsForRun(binding);
  const assignment = createPinnedToolAssignment({ connections: [], tools: [], plugins: descriptors });
  return { assignment, digest: pinnedToolAssignmentDigest(assignment) };
}

/** Plugin component of the run inventory. This is not invocation authority. */
export async function capturePluginAssignmentInventory(
  db: Db,
  binding: { companyId: string; agentId: string; runId: string },
) {
  // Resolve with the registered root gateway, not an unconfigured transaction
  // gateway. The row lock serializes competing captures across server processes.
  return db.transaction(async (tx) => {
    const [run] = await tx.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, binding.runId),
      eq(heartbeatRuns.companyId, binding.companyId),
      eq(heartbeatRuns.agentId, binding.agentId),
    )).for("update");
    if (!run) throw new Error("native_assignment_run_scope_mismatch");
    if (run.status !== "running") throw new Error("native_assignment_run_inactive");
    const snapshot = run.contextSnapshot ?? {};
    const existing = snapshot.nativePluginAssignment;
    if (existing !== undefined) return parseStoredPluginInventory(existing);
    const captured = await resolvePluginAssignmentInventory(db, binding);
    await tx.update(heartbeatRuns).set({ contextSnapshot: {
      ...snapshot, nativePluginAssignment: captured,
    } }).where(eq(heartbeatRuns.id, run.id));
    return captured;
  });
}

function parseStoredPluginInventory(value: unknown, pluginsOnly = true) {
  // Validate the persisted ceiling without reading current grants or silently
  // repairing corrupt state by recapture. Only the identity allowlist survives.
  try {
    const record = value as { assignment: { version: number; connections: unknown[]; tools: unknown[]; plugins: { name: string; pluginId: string; descriptorDigest: string }[] }; digest: string };
    const keys = (v: object, expected: string[]) => Object.keys(v).sort().join(",") === expected.sort().join(",");
    if (!keys(record, ["assignment", "digest"])) throw new Error();
    const source = record.assignment;
    if (!keys(source, ["version", "connections", "tools", "plugins"])) throw new Error();
    if (source.version !== 2 || !Array.isArray(source.connections) || !Array.isArray(source.tools) || (pluginsOnly && (source.connections.length || source.tools.length)) || !Array.isArray(source.plugins)) throw new Error();
    const seen = new Set<string>();
    const plugins = source.plugins.map(entry => {
      if (!entry || !keys(entry, ["name", "pluginId", "descriptorDigest"]) || typeof entry.name !== "string" || typeof entry.pluginId !== "string" ||
        !entry.name || !entry.pluginId || /[\s*?\x00-\x1f]/.test(entry.name + entry.pluginId) ||
        !/^[a-f0-9]{64}$/.test(entry.descriptorDigest) || seen.has(entry.name)) throw new Error();
      seen.add(entry.name);
      return Object.freeze({ name: entry.name, pluginId: entry.pluginId, descriptorDigest: entry.descriptorDigest });
    });
    const canonicalIdentities = (values: unknown[]) => {
      if (values.some(value => typeof value !== "string" || !value || /[\s*?\x00-\x1f]/.test(value))) throw new Error();
      const result = [...new Set(values as string[])].sort();
      if (JSON.stringify(result) !== JSON.stringify(values)) throw new Error();
      return Object.freeze(result);
    };
    if (plugins.some((entry, index) => index > 0 && plugins[index - 1]!.name >= entry.name)) throw new Error();
    const assignment = Object.freeze({ version: 2 as const, connections: canonicalIdentities(source.connections), tools: canonicalIdentities(source.tools), plugins: Object.freeze(plugins) });
    if (pinnedToolAssignmentDigest(assignment) !== record.digest) throw new Error();
    return { assignment, digest: record.digest };
  } catch {
    throw new Error("native_assignment_invalid_persisted_inventory");
  }
}

/**
 * Server-internal capture shared by future runtime capture and realization.
 * The app resolver must derive its catalog from authoritative run context.
 * It runs only for the first capture, under the same run lock as plugin capture.
 * Neither resolver's output is invocation authority.
 */
export async function captureToolAssignmentInventory(
  db: Db,
  binding: { companyId: string; agentId: string; runId: string },
  resolveApps: () => Promise<{ connections: readonly string[]; tools: readonly string[] }>,
) {
  return db.transaction(async (tx) => {
    const [run] = await tx.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, binding.runId),
      eq(heartbeatRuns.companyId, binding.companyId),
      eq(heartbeatRuns.agentId, binding.agentId),
    )).for("update");
    if (!run) throw new Error("native_assignment_run_scope_mismatch");
    if (run.status !== "running") throw new Error("native_assignment_run_inactive");
    const snapshot = run.contextSnapshot ?? {};
    if (snapshot.nativeToolAssignment !== undefined) return parseStoredPluginInventory(snapshot.nativeToolAssignment, false);
    // Preserve an already captured plugin ceiling. Never enlarge it during the
    // transition from the earlier plugin-only component to the full inventory.
    const plugin = snapshot.nativePluginAssignment !== undefined
      ? parseStoredPluginInventory(snapshot.nativePluginAssignment)
      : await resolvePluginAssignmentInventory(db, binding);
    const apps = await resolveApps();
    const appAssignment = createPinnedToolAssignment({ ...apps, plugins: [] });
    const assignment = Object.freeze({ ...appAssignment, plugins: plugin.assignment.plugins });
    const captured = { assignment, digest: pinnedToolAssignmentDigest(assignment) };
    await tx.update(heartbeatRuns).set({ contextSnapshot: {
      ...snapshot, nativePluginAssignment: plugin, nativeToolAssignment: captured,
    } }).where(eq(heartbeatRuns.id, run.id));
    return captured;
  });
}
