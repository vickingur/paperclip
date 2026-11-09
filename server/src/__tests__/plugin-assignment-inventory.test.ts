import { describe, expect, it, vi } from "vitest";
import * as accessPolicy from "../services/tool-access-policy.js";
import { and, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { agents, companies, createDb, connectionGrants, toolApplications, toolConnections, toolCatalogEntries, heartbeatRuns, toolProfiles, toolProfileBindings, toolProfileEntries, toolPolicies, plugins } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createToolGatewayService } from "../services/tool-gateway.js";
import { registerAssignedMcpGateway } from "../services/native-runtime/assigned-mcp-tools.js";
import { resolvePinnedPluginToolsForRun, readToolAssignmentInventory, captureToolAssignmentInventory, capturePluginAssignmentInventory, resolvePluginAssignmentInventory } from "../services/native-runtime/plugin-assignment-inventory.js";
import { buildPaperclipRuntimeMcpServers } from "../services/heartbeat/run-preparation.js";
import type { PluginToolDispatcher } from "../services/plugin-tool-dispatcher.js";
const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("configured run-scoped native plugin capture", () => {
  it("captures six exact grants without connections and rejects wrong scope, inactive runs and missing configuration", async () => {
    const temp = await startEmbeddedPostgresTestDatabase("vik906-inventory-");
    const db = createDb(temp.connectionString);
    try {
      const [company] = await db.insert(companies).values({ name: "Synthetic inventory", issuePrefix: "S906" }).returning();
      const [agent] = await db.insert(agents).values({ companyId: company!.id, name: "Synthetic engineer", role: "engineer", adapterType: "codex_local" }).returning();
      const [other] = await db.insert(agents).values({ companyId: company!.id, name: "Other engineer", role: "engineer", adapterType: "codex_local" }).returning();
      const [run] = await db.insert(heartbeatRuns).values({ companyId: company!.id, agentId: agent!.id, status: "running", contextSnapshot: { retained: "synthetic" } }).returning();
      const [inactive] = await db.insert(heartbeatRuns).values({ companyId: company!.id, agentId: agent!.id, status: "succeeded", contextSnapshot: {} }).returning();
      const names = ["reconcile", "job_list", "job_log", "job_status", "ledger", "asset_put"].map(n => `synthetic.pipeline:${n}`);
      const [profile] = await db.insert(toolProfiles).values({ companyId: company!.id, profileKey: `capture-${randomUUID()}`, name: "Existing exact grants", defaultAction: "deny" }).returning();
      await db.insert(toolProfileBindings).values({ companyId: company!.id, profileId: profile!.id, targetType: "agent", targetId: agent!.id });
      await db.insert(toolProfileEntries).values(names.map(toolName => ({ companyId: company!.id, profileId: profile!.id, selectorType: "tool_name" as const, effect: "include" as const, toolName })));
      const binding = { companyId: company!.id, agentId: agent!.id, runId: run!.id };
      await expect(resolvePluginAssignmentInventory(db, binding)).rejects.toThrow("assigned_mcp_gateway_unavailable");
      const [registration] = await db.insert(plugins).values({ pluginKey: "synthetic.pipeline",
        packageName: "synthetic-pipeline", version: "0.0.0", status: "ready",
        manifestJson: {} as never }).returning();
      const executeTool = vi.fn();
      const dispatcher = { listToolsForAgent: () => [...names, "synthetic.pipeline:ungranted"].map(name => ({ name, displayName: name, description: "Synthetic", parametersSchema: { type: "object" }, pluginId: registration!.id })), executeTool } as unknown as PluginToolDispatcher;
      registerAssignedMcpGateway(db, createToolGatewayService(db, { pluginToolDispatcher: dispatcher }));
      await expect(readToolAssignmentInventory(db, binding, "absent")).rejects.toThrow("native_assignment_not_captured");
      const captured = await resolvePluginAssignmentInventory(db, binding);
      expect(captured.assignment.plugins.map(t => t.name)).toEqual([...names].sort());
      expect(captured.assignment.connections).toEqual([]);
      expect(captured.digest).toMatch(/^[a-f0-9]{64}$/);
      await expect(resolvePluginAssignmentInventory(db, { ...binding, agentId: other!.id })).rejects.toThrow("Run does not belong to agent");
      await expect(resolvePluginAssignmentInventory(db, { ...binding, companyId: randomUUID() })).rejects.toThrow();
      await expect(resolvePluginAssignmentInventory(db, { ...binding, runId: inactive!.id })).rejects.toThrow("Run is not active");
      const [failedRun] = await db.insert(heartbeatRuns).values({ companyId: company!.id, agentId: agent!.id, status: "running", contextSnapshot: { retained: "rollback" } }).returning();
      const failedBinding = { ...binding, runId: failedRun!.id };
      await expect(captureToolAssignmentInventory(db, failedBinding, async () => { throw new Error("synthetic-app-discovery-failure"); })).rejects.toThrow("synthetic-app-discovery-failure");
      const [rolledBack] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, failedRun!.id));
      expect(rolledBack!.contextSnapshot).toEqual({ retained: "rollback" });
      const fresh = await captureToolAssignmentInventory(db, failedBinding, async () => ({ connections: [], tools: [] }));
      expect(fresh).toEqual(captured);
      const servers = await buildPaperclipRuntimeMcpServers({ db, agent: agent!, runId: failedRun!.id, expectedAssignmentDigest: fresh.digest });
      expect(await buildPaperclipRuntimeMcpServers({ db, agent: agent!, runId: failedRun!.id, expectedAssignmentDigest: null })).toEqual([]);
      expect(servers).toHaveLength(1);
      expect(servers[0]!.connectionId).toBe(`assignment:${fresh.digest}`);
      await expect(buildPaperclipRuntimeMcpServers({ db, agent: agent!, runId: failedRun!.id, expectedAssignmentDigest: "wrong" })).rejects.toThrow("native_assignment_digest_mismatch");
      // A broad session must not enlarge a captured plugin-only assignment.
      const [application] = await db.insert(toolApplications).values({ companyId: company!.id, applicationKey: "synthetic-app", name: "Synthetic app", type: "mcp_http" }).returning();
      const [connection] = await db.insert(toolConnections).values({ companyId: company!.id, applicationId: application!.id, name: "Synthetic remote", uid: "synthetic-remote", healthStatus: "ok", transport: "mcp_remote", status: "active", enabled: true, credentialPolicy: "shared", config: { url: "https://8.8.8.8/mcp" } }).returning();
      await db.insert(connectionGrants).values({ companyId: company!.id, connectionId: connection!.id, kind: "organization", status: "active", isDefault: true, credentialSecretRefs: [] });
      const [catalog] = await db.insert(toolCatalogEntries).values({ companyId: company!.id, applicationId: application!.id, connectionId: connection!.id, entryKind: "tool", name: "read_note", toolName: "read_note", title: "Read note", riskLevel: "read", isReadOnly: true, status: "active", versionHash: "synthetic", schemaHash: "synthetic" }).returning();
      await db.insert(toolProfileEntries).values({ companyId: company!.id, profileId: profile!.id, selectorType: "catalog_entry", effect: "include", catalogEntryId: catalog!.id, connectionId: connection!.id, applicationId: application!.id });
      const remoteHttpRequest = vi.fn();
      const appGateway = createToolGatewayService(db, { pluginToolDispatcher: dispatcher, remoteHttpRequest });
      const appSession = await appGateway.createSession(failedBinding);
      await expect(appGateway.executeTool({ sessionToken: appSession.token, tool: `mcp.synthetic-app-${connection!.id.replaceAll("-", "").slice(0, 8)}:read-note`, parameters: {} })).rejects.toMatchObject({ reasonCode: "native_assignment_tool_stale" });
      expect(remoteHttpRequest).not.toHaveBeenCalled();
      // Local stdio must fail before template resolution or process startup too.
      await db.update(toolApplications).set({ type: "mcp_stdio" }).where(eq(toolApplications.id, application!.id));
      await db.update(toolConnections).set({ transport: "local_stdio" }).where(eq(toolConnections.id, connection!.id));
      await expect(appGateway.executeTool({ sessionToken: appSession.token, tool: `mcp.synthetic-app-${connection!.id.replaceAll("-", "").slice(0, 8)}:read-note`, parameters: {} })).rejects.toMatchObject({ reasonCode: "native_assignment_tool_stale" });
      // Direct plugin routes must respect the same persisted ceiling as MCP.
      const dispatchGateway = createToolGatewayService(db, { pluginToolDispatcher: dispatcher });
      const call = (tool: string) => dispatchGateway.executePluginTool({
        actor: { type: "agent", companyId: company!.id, agentId: agent!.id, runId: failedRun!.id },
        tool, parameters: {}, runContext: { ...failedBinding, projectId: "" },
      });
      const originalList = dispatcher.listToolsForAgent;
      const drift = vi.spyOn(dispatcher, "listToolsForAgent").mockImplementation(() => originalList().map(t =>
        t.name === names[1] ? { ...t, description: "Replacement descriptor" } : t));
      await expect(call(names[1]!)).rejects.toThrow("outside the run inventory");
      expect(executeTool).not.toHaveBeenCalled();
      drift.mockRestore();
      // Persisted disable must deny even while the in-memory dispatcher is stale.
      await db.update(plugins).set({ status: "disabled" }).where(eq(plugins.id, registration!.id));
      await expect(call(names[1]!)).rejects.toMatchObject({ reasonCode: "plugin_registration_inactive" });
      expect(executeTool).not.toHaveBeenCalled();
      await db.update(plugins).set({ status: "ready" }).where(eq(plugins.id, registration!.id));
      let reads = 0;
      const racing = vi.spyOn(dispatcher, "listToolsForAgent").mockImplementation(() => {
        const descriptors = originalList();
        return ++reads === 1 ? descriptors : descriptors.map(t =>
          t.name === names[1] ? { ...t, description: "Changed during admission" } : t);
      });
      await expect(call(names[1]!)).rejects.toThrow("descriptor changed before dispatch");
      expect(executeTool).not.toHaveBeenCalled();
      racing.mockRestore();
      // A revoke launched at the final registry read cannot commit between
      // the authoritative policy read and dispatcher entry. Once committed,
      // subsequent direct invocation must reject without entering the worker.
      const originalPolicy = accessPolicy.toolAccessPolicyService;
      let admissionLockObserved = false;
      const policyFactory = vi.spyOn(accessPolicy, "toolAccessPolicyService").mockImplementation(policyDb => {
        const service = originalPolicy(policyDb);
        if (policyDb !== db) {
          const decide = service.decide;
          service.decide = async (...args) => {
            const locks = await policyDb.execute(sql`SELECT mode FROM pg_locks
              WHERE pid = pg_backend_pid() AND relation = 'tool_profile_entries'::regclass
                AND granted AND mode = 'ShareLock'`);
            admissionLockObserved = locks.length === 1;
            return decide(...args);
          };
        }
        return service;
      });
      const order: string[] = [];
      let revocation: Promise<unknown> | undefined;
      let revokeStarted!: () => void;
      const revocationStarted = new Promise<void>(resolve => { revokeStarted = resolve; });
      let admissionReads = 0;
      const boundary = vi.spyOn(dispatcher, "listToolsForAgent").mockImplementation(() => {
        if (++admissionReads === 2) {
          revocation = db.delete(toolProfileEntries).where(and(
            eq(toolProfileEntries.profileId, profile!.id), eq(toolProfileEntries.toolName, names[1]!),
          )).then(() => { order.push("revoke committed"); });
          revokeStarted();
        }
        return originalList();
      });
      let finishOperation!: () => void;
      const operation = new Promise<void>(resolve => { finishOperation = resolve; });
      executeTool.mockImplementationOnce(() => { order.push("admitted"); return operation.then(() => ({ ok: true })); });
      const admittedCall = call(names[1]!);
      // Observe the revoke commit while the already admitted operation remains
      // pending: admission locks must not be held for the worker's lifetime.
      await revocationStarted;
      await revocation;
      expect(order).toEqual(["admitted", "revoke committed"]);
      expect(admissionLockObserved).toBe(true);
      finishOperation();
      await admittedCall;
      boundary.mockRestore();
      policyFactory.mockRestore();
      executeTool.mockClear();
      await expect(call(names[1]!)).rejects.toThrow();
      expect(executeTool).not.toHaveBeenCalled();
      await db.insert(toolProfileEntries).values({ companyId: company!.id, profileId: profile!.id,
        selectorType: "tool_name", effect: "include", toolName: names[1]! });
      // Disable launched at the same boundary serializes with admission, even
      // if lifecycle delivery has not removed the descriptor from memory.
      const disableOrder: string[] = [];
      let disable: Promise<unknown> | undefined;
      let disableStarted!: () => void;
      const disabling = new Promise<void>(resolve => { disableStarted = resolve; });
      let disableReads = 0;
      const disableBoundary = vi.spyOn(dispatcher, "listToolsForAgent").mockImplementation(() => {
        if (++disableReads === 2) {
          disable = db.update(plugins).set({ status: "disabled" })
            .where(eq(plugins.id, registration!.id)).then(() => { disableOrder.push("disabled"); });
          disableStarted();
        }
        return originalList();
      });
      let finishDisabledOperation!: () => void;
      const disabledOperation = new Promise<void>(resolve => { finishDisabledOperation = resolve; });
      executeTool.mockImplementationOnce(() => {
        disableOrder.push("admitted");
        return disabledOperation.then(() => ({ ok: true }));
      });
      const beforeDisable = call(names[1]!);
      await disabling;
      await disable;
      expect(disableOrder).toEqual(["admitted", "disabled"]);
      finishDisabledOperation();
      await beforeDisable;
      disableBoundary.mockRestore();
      executeTool.mockClear();
      await expect(call(names[1]!)).rejects.toMatchObject({ reasonCode: "plugin_registration_inactive" });
      expect(executeTool).not.toHaveBeenCalled();
      await db.update(plugins).set({ status: "ready" }).where(eq(plugins.id, registration!.id));
      const listSpy = vi.spyOn(dispatcher, "listToolsForAgent");
      const concurrent = await Promise.all(Array.from({ length: 3 }, () => capturePluginAssignmentInventory(db, binding)));
      expect(listSpy).toHaveBeenCalledTimes(1);
      expect(concurrent).toEqual([captured, captured, captured]);
      expect(Object.isFrozen(concurrent[1]!.assignment.plugins)).toBe(true);
      await expect(capturePluginAssignmentInventory(db, { ...binding, agentId: other!.id })).rejects.toThrow("native_assignment_run_scope_mismatch");
      await expect(capturePluginAssignmentInventory(db, { ...binding, runId: inactive!.id })).rejects.toThrow("native_assignment_run_inactive");
      await db.insert(toolPolicies).values({ companyId: company!.id, name: "Synthetic approval", policyType: "require_approval", selectors: { toolName: names[0] } }).returning();
      const approvalCapture = await resolvePluginAssignmentInventory(db, binding);
      expect(approvalCapture.digest).not.toBe(captured.digest);
      expect(await capturePluginAssignmentInventory(db, binding)).toEqual(captured);
      const [persisted] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run!.id));
      expect(persisted!.contextSnapshot).toEqual({ retained: "synthetic", nativePluginAssignment: captured });
      const resolveApps = vi.fn(async () => ({ connections: ["synthetic-app", "synthetic-app"], tools: ["tool-b", "tool-a"] }));
      listSpy.mockClear();
      const unified = await Promise.all(Array.from({ length: 3 }, () => captureToolAssignmentInventory(db, binding, resolveApps)));
      expect(resolveApps).toHaveBeenCalledTimes(1);
      expect(listSpy).not.toHaveBeenCalled();
      expect(unified[1]).toEqual(unified[0]);
      expect(unified[0]!.assignment).toEqual({ ...captured.assignment, connections: ["synthetic-app"], tools: ["tool-a", "tool-b"] });
      expect(unified[0]!.digest).not.toBe(captured.digest);
      expect(Object.isFrozen(unified[1]!.assignment.connections)).toBe(true);
      resolveApps.mockResolvedValue({ connections: ["new-app"], tools: [] });
      expect(await captureToolAssignmentInventory(db, binding, resolveApps)).toEqual(unified[0]);
      expect(resolveApps).toHaveBeenCalledTimes(1);
      await expect(captureToolAssignmentInventory(db, { ...binding, agentId: other!.id }, resolveApps)).rejects.toThrow("native_assignment_run_scope_mismatch");
      await expect(captureToolAssignmentInventory(db, { ...binding, runId: inactive!.id }, resolveApps)).rejects.toThrow("native_assignment_run_inactive");
      listSpy.mockClear();
      expect(await readToolAssignmentInventory(db, binding, unified[0]!.digest)).toEqual(unified[0]);
      // Live approval policy already changed after plugin capture. The immutable
      // digest, rather than the current descriptor intersection, remains valid.
      await expect(readToolAssignmentInventory(db, binding, approvalCapture.digest)).rejects.toThrow("native_assignment_digest_mismatch");
      await expect(readToolAssignmentInventory(db, { ...binding, agentId: other!.id }, unified[0]!.digest)).rejects.toThrow("native_assignment_run_scope_mismatch");
      await expect(readToolAssignmentInventory(db, { ...binding, companyId: randomUUID() }, unified[0]!.digest)).rejects.toThrow("native_assignment_run_scope_mismatch");
      await expect(readToolAssignmentInventory(db, { ...binding, runId: inactive!.id }, unified[0]!.digest)).rejects.toThrow("native_assignment_run_inactive");
      await expect(readToolAssignmentInventory(db, failedBinding, unified[0]!.digest)).rejects.toThrow("native_assignment_digest_mismatch");
      expect(listSpy).not.toHaveBeenCalled();
      // A policy edit after capture changes the descriptor identity. It must
      // disappear from exposure without changing the immutable run ceiling.
      const intersection = await resolvePinnedPluginToolsForRun(db, binding, unified[0]!.digest);
      expect(intersection.stale).toEqual([names[0]]);
      expect(intersection.permitted.map(t => t.name)).toEqual([...names].filter(n => n !== names[0]).sort());
      listSpy.mockClear();
      await expect(resolvePinnedPluginToolsForRun(db, binding, "wrong-digest")).rejects.toThrow("native_assignment_digest_mismatch");
      expect(listSpy).not.toHaveBeenCalled();
      await db.delete(toolProfileEntries).where(and(eq(toolProfileEntries.profileId, profile!.id), eq(toolProfileEntries.toolName, names[1]!)));
      const revoked = await resolvePinnedPluginToolsForRun(db, binding, unified[0]!.digest);
      expect(revoked.permitted.map(t => t.name)).not.toContain(names[1]);
      expect(revoked.permitted.map(t => t.name)).not.toContain("synthetic.pipeline:ungranted");
      await db.insert(toolProfileEntries).values([
        { companyId: company!.id, profileId: profile!.id, selectorType: "tool_name", effect: "include", toolName: names[1]! },
        { companyId: company!.id, profileId: profile!.id, selectorType: "tool_name", effect: "include", toolName: "synthetic.pipeline:ungranted" },
      ]);
      const regranted = await resolvePinnedPluginToolsForRun(db, binding, unified[0]!.digest);
      expect(regranted.permitted.map(t => t.name)).toContain(names[1]);
      expect(regranted.permitted.map(t => t.name)).not.toContain("synthetic.pipeline:ungranted");
      expect(await readToolAssignmentInventory(db, binding, unified[0]!.digest)).toEqual(unified[0]);
      const [full] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run!.id));
      expect(full!.contextSnapshot).toEqual({ retained: "synthetic", nativePluginAssignment: captured, nativeToolAssignment: unified[0] });
      await db.update(heartbeatRuns).set({ contextSnapshot: { nativeToolAssignment: { ...unified[0], digest: "corrupt" } } }).where(eq(heartbeatRuns.id, run!.id));
      await expect(captureToolAssignmentInventory(db, binding, resolveApps)).rejects.toThrow("native_assignment_invalid_persisted_inventory");
      await expect(readToolAssignmentInventory(db, binding, unified[0]!.digest)).rejects.toThrow("native_assignment_invalid_persisted_inventory");
      expect(resolveApps).toHaveBeenCalledTimes(1);
      await db.update(heartbeatRuns).set({ contextSnapshot: { nativePluginAssignment: { ...captured, digest: "corrupt" } } }).where(eq(heartbeatRuns.id, run!.id));
      await expect(capturePluginAssignmentInventory(db, binding)).rejects.toThrow("native_assignment_invalid_persisted_inventory");
      const approvedDescriptor = (await createToolGatewayService(db, { pluginToolDispatcher: dispatcher }).listPluginToolsForRun(binding)).find(t => t.name === names[0]);
      expect(approvedDescriptor?.annotations).toEqual({ requiresApproval: true });
      registerAssignedMcpGateway(db, createToolGatewayService(db, { pluginToolDispatcher: { ...dispatcher, listToolsForAgent() { throw new Error("synthetic-private-error"); } } }));
      await expect(resolvePluginAssignmentInventory(db, binding)).rejects.toThrow("Native plugin discovery failed");
      registerAssignedMcpGateway(db, createToolGatewayService(db));
      await expect(resolvePluginAssignmentInventory(db, binding)).rejects.toThrow("Native plugin discovery is unavailable");
      expect(executeTool).not.toHaveBeenCalled();
    } finally { await temp.cleanup(); }
  }, 60000);
});
