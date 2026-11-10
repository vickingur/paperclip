import { describe, expect, it } from "vitest";
import { createPinnedToolAssignment, hasPinnedTools, intersectPinnedPluginTools, pinnedToolAssignmentDigest, type PinnablePluginDescriptor } from "../services/native-runtime/pinned-tool-assignment.js";
const descriptor = (name = "synthetic.pipeline:ledger"): PinnablePluginDescriptor => ({ name, pluginId: "registration-a", displayName: name, description: "Synthetic tool", parametersSchema: { type: "object", properties: { id: { type: "string" } } } });
const pin = (plugins: PinnablePluginDescriptor[]) => createPinnedToolAssignment({ connections: [], tools: [], plugins });
describe("immutable native tool inventory primitives", () => {
  it("binds six connectionless tools and preserves mixed app identities", () => {
    const plugins = ["reconcile", "job_list", "job_log", "job_status", "ledger", "asset_put"].map(name => descriptor(`synthetic.pipeline:${name}`));
    expect(hasPinnedTools(pin(plugins))).toBe(true);
    expect(pin(plugins).plugins).toHaveLength(6);
    const mixed = createPinnedToolAssignment({ connections: ["connection-b", "connection-a", "connection-b"], tools: ["catalog-b", "catalog-a"], plugins });
    expect(mixed.connections).toEqual(["connection-a", "connection-b"]);
    expect(mixed.tools).toEqual(["catalog-a", "catalog-b"]);
    expect(hasPinnedTools(pin([]))).toBe(false);
  });
  it("canonicalizes object keys, inventory order and duplicates", () => {
    const a = descriptor();
    const b = { ...a, parametersSchema: { properties: { id: { type: "string" } }, type: "object" } };
    expect(pinnedToolAssignmentDigest(pin([a, descriptor("synthetic.pipeline:asset_put"), b])))
      .toBe(pinnedToolAssignmentDigest(pin([descriptor("synthetic.pipeline:asset_put"), b])));
  });
  it("drops revoked tools, prevents additions and permits unchanged regrants", () => {
    const a = descriptor(), b = descriptor("synthetic.pipeline:asset_put");
    const assignment = pin([a]);
    const original = pinnedToolAssignmentDigest(assignment);
    expect(intersectPinnedPluginTools(assignment, []).permitted).toEqual([]);
    expect(intersectPinnedPluginTools(assignment, [a, b]).permitted).toEqual([a]);
    expect(pinnedToolAssignmentDigest(assignment)).toBe(original);
    expect(intersectPinnedPluginTools(pin([a, b]), [a, b]).permitted).toHaveLength(2);
  });
  it.each([
    { pluginId: "replacement-registration" },
    { parametersSchema: { type: "object", required: ["id"] } },
    { description: "Changed semantics" },
    { annotations: { requiresApproval: true } },
  ])("withholds changed descriptor identity: %j", change => {
    const a = descriptor();
    expect(intersectPinnedPluginTools(pin([a]), [{ ...a, ...change }])).toEqual({ permitted: [], stale: [a.name] });
  });
  it("keeps unchanged peers visible during descriptor drift", () => {
    const a = descriptor(), b = descriptor("synthetic.pipeline:asset_put");
    expect(intersectPinnedPluginTools(pin([a, b]), [a, { ...b, pluginId: "replacement" }])).toEqual({ permitted: [a], stale: [b.name] });
  });
  it("rejects wildcard selectors and conflicting canonical names", () => {
    for (const name of ["*", "synthetic.pipeline:*", "synthetic.pipeline:?", " tool", "a\nb"]) expect(() => pin([descriptor(name)])).toThrow("native_assignment_invalid_identity");
    const a = descriptor();
    expect(() => pin([a, { ...a, pluginId: "replacement" }])).toThrow("native_assignment_tool_collision");
    expect(() => intersectPinnedPluginTools(pin([a]), [a, { ...a, description: "conflicting" }])).toThrow("native_assignment_tool_collision");
  });
  it("does not persist unknown transport credentials or run provenance", () => {
    const extra = { ...descriptor(), token: "synthetic-secret", runId: "synthetic-run", companyId: "synthetic-company" };
    const serialized = JSON.stringify(pin([extra]));
    expect(serialized).not.toContain("synthetic-secret");
    expect(serialized).not.toContain("synthetic-run");
    expect(serialized).not.toContain("synthetic-company");
    expect(pinnedToolAssignmentDigest(pin([extra]))).toBe(pinnedToolAssignmentDigest(pin([descriptor()])));
  });
  it("freezes every inventory collection so consumers cannot enlarge the pin", () => {
    const assignment = pin([descriptor()]);
    expect(Object.isFrozen(assignment)).toBe(true);
    expect(Object.isFrozen(assignment.plugins)).toBe(true);
    expect(Object.isFrozen(assignment.plugins[0])).toBe(true);
    expect(Object.isFrozen(assignment.connections)).toBe(true);
    expect(Object.isFrozen(assignment.tools)).toBe(true);
    const before = pinnedToolAssignmentDigest(assignment);
    expect(() => (assignment.plugins as unknown as unknown[]).push({})).toThrow();
    expect(pinnedToolAssignmentDigest(assignment)).toBe(before);
  });
  it("preserves meaningful schema array order and rejects non-JSON values", () => {
    const a = descriptor();
    const one = { ...a, parametersSchema: { enum: ["a", "b"] } };
    const two = { ...a, parametersSchema: { enum: ["b", "a"] } };
    expect(pinnedToolAssignmentDigest(pin([one]))).not.toBe(pinnedToolAssignmentDigest(pin([two])));
    for (const value of [NaN, Infinity, undefined, new Date()]) {
      expect(() => pin([{ ...a, parametersSchema: { value } }])).toThrow("native_assignment_invalid_json");
    }
  });

});
