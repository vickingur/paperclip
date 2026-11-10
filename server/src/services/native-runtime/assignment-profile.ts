import type { CreateToolProfileEntryForProfile } from "@paperclipai/shared";
import { intersectPinnedPluginTools, type PinnablePluginDescriptor, type PinnedToolAssignment } from "./pinned-tool-assignment.js";

/** Build an exact profile ceiling from a persisted inventory and fresh policy.
 * Never emit connection-wide selectors: those admit catalog additions after
 * capture. These selectors still require current authorization at invocation.
 */
export function projectPinnedAssignmentProfile(input: {
  assignment: PinnedToolAssignment;
  connections: readonly string[];
  tools: readonly { id: string; connectionId: string; applicationId: string | null }[];
  plugins: readonly PinnablePluginDescriptor[];
}): CreateToolProfileEntryForProfile[] {
  const connections = new Set(input.connections.filter(id => input.assignment.connections.includes(id)));
  const catalog = new Map<string, { id: string; connectionId: string; applicationId: string | null }>();
  for (const tool of input.tools) {
    const previous = catalog.get(tool.id);
    if (previous && (previous.connectionId !== tool.connectionId || previous.applicationId !== tool.applicationId)) {
      throw new Error("native_assignment_catalog_collision");
    }
    catalog.set(tool.id, tool);
  }
  const entries: CreateToolProfileEntryForProfile[] = [];
  for (const id of input.assignment.tools) {
    const tool = catalog.get(id);
    if (!tool || !connections.has(tool.connectionId)) continue;
    entries.push({ selectorType: "catalog_entry", effect: "include", catalogEntryId: tool.id,
      connectionId: tool.connectionId, applicationId: tool.applicationId });
  }
  const plugins = intersectPinnedPluginTools(input.assignment, input.plugins);
  entries.push(...plugins.permitted.map(tool => ({
    selectorType: "tool_name" as const, effect: "include" as const, toolName: tool.name,
  })));
  return entries;
}
