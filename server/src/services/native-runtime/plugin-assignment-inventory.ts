import type { Db } from "@paperclipai/db";
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
