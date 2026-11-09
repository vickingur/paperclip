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

function parseStoredPluginInventory(value: unknown) {
  // Validate the persisted ceiling without reading current grants or silently
  // repairing corrupt state by recapture. Only the identity allowlist survives.
  try {
    const record = value as { assignment: { version: number; connections: unknown[]; tools: unknown[]; plugins: { name: string; pluginId: string; descriptorDigest: string }[] }; digest: string };
    const keys = (v: object, expected: string[]) => Object.keys(v).sort().join(",") === expected.sort().join(",");
    if (!keys(record, ["assignment", "digest"])) throw new Error();
    const source = record.assignment;
    if (!keys(source, ["version", "connections", "tools", "plugins"])) throw new Error();
    if (source.version !== 2 || !Array.isArray(source.connections) || !Array.isArray(source.tools) || source.connections.length || source.tools.length || !Array.isArray(source.plugins)) throw new Error();
    const seen = new Set<string>();
    const plugins = source.plugins.map(entry => {
      if (!entry || !keys(entry, ["name", "pluginId", "descriptorDigest"]) || typeof entry.name !== "string" || typeof entry.pluginId !== "string" ||
        !entry.name || !entry.pluginId || /[\s*?\x00-\x1f]/.test(entry.name + entry.pluginId) ||
        !/^[a-f0-9]{64}$/.test(entry.descriptorDigest) || seen.has(entry.name)) throw new Error();
      seen.add(entry.name);
      return Object.freeze({ name: entry.name, pluginId: entry.pluginId, descriptorDigest: entry.descriptorDigest });
    });
    const assignment = Object.freeze({ version: 2 as const, connections: Object.freeze([] as string[]), tools: Object.freeze([] as string[]), plugins: Object.freeze(plugins) });
    if (pinnedToolAssignmentDigest(assignment) !== record.digest) throw new Error();
    return { assignment, digest: record.digest };
  } catch {
    throw new Error("native_assignment_invalid_persisted_inventory");
  }
}
