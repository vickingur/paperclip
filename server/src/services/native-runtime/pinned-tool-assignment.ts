import { createHash } from "node:crypto";

/** Inventory identity only. Authentication and current authorization are separate. */
export interface PinnedPluginTool {
  name: string;
  pluginId: string;
  descriptorDigest: string;
}
export interface PinnedToolAssignment {
  readonly version: 2;
  readonly connections: readonly string[];
  readonly tools: readonly string[];
  readonly plugins: readonly Readonly<PinnedPluginTool>[];
}
export interface PinnablePluginDescriptor {
  name: string;
  pluginId: string;
  displayName: string;
  description: string;
  parametersSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

// Object order is immaterial; schema array order remains significant. Never
// serialize arbitrary descriptor properties: a future transport field could
// contain credentials or volatile run provenance.
function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
  }
  throw new Error("native_assignment_invalid_json");
}
function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
function exact(value: string): string {
  if (typeof value !== "string" || !value || value.trim() !== value || /[\s*?\x00-\x1f]/.test(value)) {
    throw new Error("native_assignment_invalid_identity");
  }
  return value;
}
function identities(values: readonly string[]): string[] {
  return [...new Set(values.map(exact))].sort();
}
export function pinPluginDescriptor(tool: PinnablePluginDescriptor): PinnedPluginTool {
  const name = exact(tool.name);
  const pluginId = exact(tool.pluginId);
  return {
    name, pluginId,
    descriptorDigest: digest({
      version: 1, name, pluginId, displayName: tool.displayName,
      description: tool.description, parametersSchema: tool.parametersSchema,
      annotations: tool.annotations ?? {},
    }),
  };
}
export function createPinnedToolAssignment(input: {
  connections: readonly string[];
  tools: readonly string[];
  plugins: readonly PinnablePluginDescriptor[];
}): PinnedToolAssignment {
  const plugins = new Map<string, PinnedPluginTool>();
  for (const descriptor of input.plugins) {
    const entry = pinPluginDescriptor(descriptor);
    const prior = plugins.get(entry.name);
    if (prior && (prior.pluginId !== entry.pluginId || prior.descriptorDigest !== entry.descriptorDigest)) {
      throw new Error("native_assignment_tool_collision");
    }
    plugins.set(entry.name, entry);
  }
  return Object.freeze({
    version: 2 as const, connections: Object.freeze(identities(input.connections)), tools: Object.freeze(identities(input.tools)),
    plugins: Object.freeze([...plugins.values()].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0).map(entry => Object.freeze(entry))),
  });
}
export function pinnedToolAssignmentDigest(assignment: PinnedToolAssignment): string {
  if (assignment.version !== 2) throw new Error("native_assignment_unsupported_version");
  return digest({ version: assignment.version, connections: assignment.connections, tools: assignment.tools, plugins: assignment.plugins });
}
export function hasPinnedTools(assignment: PinnedToolAssignment): boolean {
  return assignment.connections.length > 0 || assignment.plugins.length > 0;
}
/** The caller must supply CURRENT policy-filtered descriptors, never cached grants. */
export function intersectPinnedPluginTools(
  assignment: PinnedToolAssignment, current: readonly PinnablePluginDescriptor[],
): { permitted: PinnablePluginDescriptor[]; stale: string[] } {
  // Reject ambiguous live identity rather than choosing whichever provider won.
  const live = createPinnedToolAssignment({ connections: [], tools: [], plugins: current });
  const liveByName = new Map(live.plugins.map(tool => [tool.name, tool]));
  const descriptors = new Map(current.map(tool => [tool.name, tool]));
  const permitted: PinnablePluginDescriptor[] = [];
  const stale: string[] = [];
  for (const pinned of assignment.plugins) {
    const tool = liveByName.get(pinned.name);
    if (!tool) continue;
    if (tool.pluginId !== pinned.pluginId || tool.descriptorDigest !== pinned.descriptorDigest) {
      stale.push(pinned.name);
      continue;
    }
    permitted.push(descriptors.get(pinned.name)!);
  }
  return { permitted, stale };
}
