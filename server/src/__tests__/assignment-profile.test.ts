import { describe, expect, it } from "vitest";
import { projectPinnedAssignmentProfile } from "../services/native-runtime/assignment-profile.js";
import { createPinnedToolAssignment } from "../services/native-runtime/pinned-tool-assignment.js";
const plugin = (name: string) => ({ name: `synthetic.pipeline:${name}`, pluginId: "synthetic-registration", displayName: name, description: "Synthetic", parametersSchema: { type: "object" } });
const tool = { id: "catalog-a", connectionId: "connection-a", applicationId: "app-a" };
const plugins = ["reconcile", "job_list", "job_log", "job_status", "ledger", "asset_put"].map(plugin);
const assignment = createPinnedToolAssignment({ connections: [tool.connectionId], tools: [tool.id], plugins });
const current = { assignment, connections: [tool.connectionId], tools: [tool], plugins };
describe("exact native assignment profile projection", () => {
  it("projects all six connectionless plugin tools without app prerequisites", () => {
    const entries = projectPinnedAssignmentProfile({ ...current, connections: [], tools: [] });
    expect(entries).toEqual(assignment.plugins.map(p => ({ selectorType: "tool_name", effect: "include", toolName: p.name })));
  });
  it("uses exact catalog selectors and withholds new catalog and plugin grants", () => {
    const entries = projectPinnedAssignmentProfile({ ...current, tools: [tool, { ...tool, id: "new-catalog" }], plugins: [...plugins, plugin("new_tool")] });
    expect(entries).toHaveLength(7);
    expect(entries[0]).toEqual({ selectorType: "catalog_entry", effect: "include", catalogEntryId: tool.id, connectionId: tool.connectionId, applicationId: tool.applicationId });
    expect(entries.some(e => e.selectorType === "connection")).toBe(false);
    expect(JSON.stringify(entries)).not.toContain("new-catalog");
    expect(JSON.stringify(entries)).not.toContain("new_tool");
  });
  it("preserves exact catalog routing when the application is absent", () => {
    const unbound = { ...tool, applicationId: null };
    expect(projectPinnedAssignmentProfile({ ...current, tools: [unbound], plugins: [] }))
      .toEqual([{ selectorType: "catalog_entry", effect: "include", catalogEntryId: tool.id,
        connectionId: tool.connectionId, applicationId: null }]);
    expect(() => projectPinnedAssignmentProfile({ ...current, tools: [unbound, tool] }))
      .toThrow("native_assignment_catalog_collision");
  });
  it("withholds revoked connections, catalog entries and changed plugin registrations", () => {
    expect(projectPinnedAssignmentProfile({ ...current, connections: [], plugins: [] })).toEqual([]);
    expect(projectPinnedAssignmentProfile({ ...current, tools: [], plugins: [] })).toEqual([]);
    expect(projectPinnedAssignmentProfile({ ...current, connections: [], tools: [], plugins: plugins.map(p => ({ ...p, pluginId: "replacement" })) })).toEqual([]);
    expect(projectPinnedAssignmentProfile(current)).toHaveLength(7);
  });
  it("rejects conflicting live catalog routing and descriptor identities", () => {
    expect(() => projectPinnedAssignmentProfile({ ...current, tools: [tool, { ...tool, connectionId: "replacement" }] })).toThrow("native_assignment_catalog_collision");
    expect(() => projectPinnedAssignmentProfile({ ...current, plugins: [...plugins, { ...plugins[0]!, pluginId: "replacement" }] })).toThrow("native_assignment_tool_collision");
  });
});
