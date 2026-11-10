import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import type { ToolGatewayService } from "../tool-gateway.js";
import { registerAssignedMcpGateway, resolveAssignedPluginToolInventoryDigestForRun } from "./assigned-mcp-tools.js";

describe("per-run plugin tool inventory", () => {
  it("detects grants, removals, and schema changes while ignoring ordering", async () => {
    const db = {} as Db;
    const binding = { companyId: "company", agentId: "agent" };
    const tool = (name: string, parametersSchema = {}) => ({ name, displayName: name, description: "fixture", parametersSchema, pluginId: "fixture" });
    const listPluginToolsForAgent = vi.fn().mockResolvedValue([tool("status")]);
    registerAssignedMcpGateway(db, { listPluginToolsForAgent } as unknown as ToolGatewayService);
    const digest = () => resolveAssignedPluginToolInventoryDigestForRun(db, binding);
    const before = await digest();
    listPluginToolsForAgent.mockResolvedValue([{ ...tool("status"), transport: { token: "synthetic-rotation" }, runId: "other-run" }]);
    expect(await digest()).toBe(before);
    listPluginToolsForAgent.mockResolvedValue([tool("status"), tool("asset_put", { type: "object", properties: {} })]);
    const granted = await digest();
    expect(granted).not.toBe(before);
    listPluginToolsForAgent.mockResolvedValue([tool("asset_put", { properties: {}, type: "object" }), tool("status")]);
    expect(await digest()).toBe(granted);
    listPluginToolsForAgent.mockResolvedValue([tool("status"), tool("asset_put", { type: "string" })]);
    expect(await digest()).not.toBe(granted);
    listPluginToolsForAgent.mockResolvedValue([tool("status")]);
    expect(await digest()).toBe(before);
    expect(listPluginToolsForAgent).toHaveBeenLastCalledWith(binding);
  });

  it("does not invent access without a configured gateway and propagates discovery failure", async () => {
    const db = {} as Db;
    const binding = { companyId: "company", agentId: "agent" };
    await expect(resolveAssignedPluginToolInventoryDigestForRun(db, binding)).resolves.toBeNull();
    registerAssignedMcpGateway(db, { listPluginToolsForAgent: vi.fn().mockRejectedValue(new Error("discovery failed")) } as unknown as ToolGatewayService);
    await expect(resolveAssignedPluginToolInventoryDigestForRun(db, binding)).rejects.toThrow("discovery failed");
  });
});
