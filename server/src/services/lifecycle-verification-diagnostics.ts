import { readAiConnectionConfigurationFailure } from "./ai-connection-configuration-failure.js";
// Only finite metadata crosses the failure-reporting boundary. Errors stay private.
export type VerificationSubstage = "binding_schema" | "secret_resolution" |
  "environment_target_resolution" | "managed_preparation" | "provider_test" | "cleanup_release";
const substages = new WeakMap<object, VerificationSubstage>();
export function markVerificationFailure(error: unknown, stage: VerificationSubstage) {
  if (typeof error === "object" && error !== null && !substages.has(error)) substages.set(error, stage);
}
export function verificationFailureSubstage(error: unknown) {
  return typeof error === "object" && error !== null ? substages.get(error) : undefined;
}
const allowedCodes = new Set([
  "required_plugin_unavailable", "invalid_lifecycle_result", "harness_test_failed", "test_environment_unavailable",
  "ai_connection_incompatible", "ai_connection_credential_not_shared", "ai_connection_credential_missing",
  "ai_connection_responsible_user_missing", "ai_connection_missing", "ai_connection_unavailable",
  "ai_connection_default_missing", "ai_connection_busy", "ai_connection_router_disabled",
  "connection_unavailable", "incompatible_connection", "configuration_incomplete",
  "EACCES", "EPERM", "ENOENT", "ENOSPC", "EROFS", "EMFILE", "ENFILE",
  "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "40001", "40P01", "53300", "57P01",
]);
export function lifecycleFailureCode(error: unknown): string {
  const candidate = error as { code?: unknown; details?: { code?: unknown }; cause?: { code?: unknown; details?: { code?: unknown } } } | null;
  return [readAiConnectionConfigurationFailure(error), readAiConnectionConfigurationFailure(candidate?.cause), candidate?.code, candidate?.details?.code, candidate?.cause?.code, candidate?.cause?.details?.code]
    .find((code): code is string => typeof code === "string" && allowedCodes.has(code)) ?? "unclassified";
}
// The stored lifecycle error uses the same finite metadata as the log.
export function lifecycleFailureDescription(error: unknown): string {
  const substage = verificationFailureSubstage(error);
  return `The lifecycle step failed (failureCode=${lifecycleFailureCode(error)}${substage ? `; verificationSubstage=${substage}` : ""}). Retry the operation.`;
}

// A cleanup failure must never replace the original thrown value, even undefined.
export async function withPreservedFailure<T>(work: () => Promise<T>, cleanup: () => Promise<void>): Promise<T> {
  let failed = false;
  try { return await work(); }
  catch (error) { failed = true; throw error; }
  finally {
    try { await cleanup(); }
    catch (error) { if (!failed) throw error; }
  }
}
