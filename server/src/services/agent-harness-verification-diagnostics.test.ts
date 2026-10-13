import { beforeEach, describe, expect, it, vi } from "vitest";
import { withPreservedFailure, verificationFailureSubstage } from "./lifecycle-verification-diagnostics.js";
const fake = vi.hoisted(() => ({
  config: vi.fn(), environmentId: vi.fn(), target: vi.fn(), provider: vi.fn(), release: vi.fn(), managed: vi.fn(),
}));
vi.mock("../adapters/index.js", () => ({ requireServerAdapter: () => ({ testEnvironment: fake.provider }) }));
vi.mock("./agent-environment-test.js", () => ({ agentEnvironmentTestService: () => ({
  resolveAdapterTestEnvironmentId: fake.environmentId, resolveAdapterTestExecutionContext: fake.target,
  testManagedEnvironment: fake.provider,
}) }));
vi.mock("./secrets.js", () => ({ secretService: () => ({ resolveAdapterConfigForRuntime: fake.config }) }));
vi.mock("./environments.js", () => ({ environmentService: () => ({}) }));
vi.mock("./ai-connection-router.js", () => ({ aiConnectionRouterService: () => ({}) }));
vi.mock("./dot-runner-broker.js", () => ({ dotRunnerBroker: () => ({}) }));
vi.mock("./ai-connection-runtime.js", () => ({ withManagedAiProbe: fake.managed, stripAiAuthBindings: () => ({}) }));
import { agentHarnessVerificationService } from "./agent-harness-verification.js";

function verification(aiConnection?: unknown) {
  const rows = [{ id: "synthetic", companyId: "synthetic", adapterType: "process", adapterConfig: {},
    runtimeConfig: { aiConnection }, lifecycleVersion: 1, lifecycleOperation: { responsibleUserId: "synthetic" } }, { defaultResponsibleUserId: "synthetic" }];
  const db = { select: () => ({ from: () => ({ where: async () => [rows.shift()] }) }) };
  return agentHarnessVerificationService(db as never, {} as never).verify({ id: "synthetic", lifecycleVersion: 1 } as never);
}
beforeEach(() => {
  vi.resetAllMocks();
  fake.config.mockResolvedValue({ config: {} });
  fake.environmentId.mockResolvedValue(null);
  fake.target.mockResolvedValue({ fallbackChecks: [], release: fake.release });
  fake.provider.mockResolvedValue({ status: "pass", checks: [] });
  fake.release.mockResolvedValue(undefined);
});
describe("verification failure wiring", () => {
  it.each([
    ["secret_resolution", "config"],
    ["environment_target_resolution", "target"],
    ["provider_test", "provider"],
    ["cleanup_release", "release"],
  ] as const)("records %s", async (stage, method) => {
    const error = new Error("synthetic private content");
    fake[method].mockRejectedValue(error);
    await expect(verification()).rejects.toBe(error);
    expect(verificationFailureSubstage(error)).toBe(stage);
  });
  it("preserves provider error through target release failure", async () => {
    const provider = new Error("synthetic provider content");
    fake.provider.mockRejectedValue(provider);
    fake.release.mockRejectedValue(new Error("synthetic cleanup content"));
    await expect(verification()).rejects.toBe(provider);
    expect(verificationFailureSubstage(provider)).toBe("provider_test");
    expect(fake.release).toHaveBeenCalledWith("failed");
  });
  it("marks schema failure before resolving secrets", async () => {
    const error = await verification({ mode: "synthetic-invalid" }).catch(error => error);
    expect(verificationFailureSubstage(error)).toBe("binding_schema");
    expect(fake.config).not.toHaveBeenCalled();
  });
  const binding = { mode: "responsible_user", provider: "anthropic", method: "subscription" };
  it("marks managed preparation failure", async () => {
    const error = new Error("synthetic preparation content");
    fake.managed.mockRejectedValue(error);
    await expect(verification(binding)).rejects.toBe(error);
    expect(verificationFailureSubstage(error)).toBe("managed_preparation");
  });
  it("keeps provider stage when managed cleanup also fails", async () => {
    const error = new Error("synthetic provider content");
    fake.provider.mockRejectedValue(error);
    fake.managed.mockImplementation(async (_db, _input, probe, onCleanup) =>
      withPreservedFailure(() => probe({ config: {} }), async () => {
        onCleanup(); throw new Error("synthetic managed cleanup");
      }));
    await expect(verification(binding)).rejects.toBe(error);
    expect(verificationFailureSubstage(error)).toBe("provider_test");
  });
  it("marks managed cleanup failure after provider success", async () => {
    const error = new Error("synthetic managed cleanup");
    fake.managed.mockImplementation(async (_db, _input, probe, onCleanup) => {
      await probe({ config: {} }); onCleanup(); throw error;
    });
    await expect(verification(binding)).rejects.toBe(error);
    expect(verificationFailureSubstage(error)).toBe("cleanup_release");
  });
  it("releases a successful verification", async () => {
    await expect(verification()).resolves.toBe("complete");
    expect(fake.release).toHaveBeenCalledWith("released");
  });
});
