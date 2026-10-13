import { describe, expect, it, vi } from "vitest";
import { createLifecycleWorker } from "../application/worker.js";
import type { LifecycleAgent, LifecycleStore, LifecycleDriver } from "../application/ports.js";
import { lifecycleFailureDescription, markVerificationFailure, type VerificationSubstage } from "../../../services/lifecycle-verification-diagnostics.js";

describe("stored lifecycle failure diagnostics", () => {
  it.each(["binding_schema", "secret_resolution", "environment_target_resolution", "managed_preparation",
    "provider_test", "cleanup_release"] satisfies VerificationSubstage[])("persists safe metadata for %s", async substage => {
    const error = Object.assign(new Error("private provider credential"), {
      details: { code: "ai_connection_incompatible", config: "private config", env: "private env" },
    });
    markVerificationFailure(error, substage);
    const agent: LifecycleAgent = { id: "synthetic-agent", companyId: "synthetic-company", lifecycleState: "verifying",
      lifecycleVersion: 1, lifecycleRequiredPluginIds: [], lifecycleError: null,
      lifecycleOperation: { id: "synthetic-operation", hostComplete: false, completedPluginIds: [], attempts: 0 } };
    const store: LifecycleStore = {
      get: vi.fn(), claim: vi.fn().mockResolvedValue(agent), renew: vi.fn().mockResolvedValue(true),
      setRequiredPlugins: vi.fn(), completeHost: vi.fn(), completePlugin: vi.fn(), change: vi.fn(),
      defer: vi.fn().mockImplementation(async (_agent, _owner, publicError) => { agent.lifecycleError = publicError; return true; }),
      pending: vi.fn(),
    };
    const driver: LifecycleDriver = { requiredPluginIds: vi.fn(), runHost: vi.fn().mockRejectedValue(error), runPlugin: vi.fn() };
    const report = vi.fn();
    const worker = createLifecycleWorker(store, driver, report, () => true, lifecycleFailureDescription);
    try { await worker.process(agent.id); } finally { await worker.stop(); }
    expect(agent.lifecycleError).toBe(`The lifecycle step failed (failureCode=ai_connection_incompatible; verificationSubstage=${substage}). Retry the operation.`);
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ stage: "host" }), error);
    expect(store.completeHost).not.toHaveBeenCalled();
    expect(agent.lifecycleState).toBe("verifying");
    expect(agent.lifecycleError).not.toContain("private");
  });

  it.each([
    [null, "unclassified"],
    ["private credential", "unclassified"],
    [{ code: "private credential", details: { code: "private config" } }, "unclassified"],
    [{ cause: { details: { code: "ai_connection_credential_not_shared" } } }, "ai_connection_credential_not_shared"],
    [{ code: "EACCES" }, "EACCES"],
  ])("stores only allowlisted codes for an unmarked failure", (error, code) => {
    expect(lifecycleFailureDescription(error)).toBe(`The lifecycle step failed (failureCode=${code}). Retry the operation.`);
  });
});
