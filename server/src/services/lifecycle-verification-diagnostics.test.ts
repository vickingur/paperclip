import { aiConnectionCredentialNotSharedFailure } from "./ai-connection-configuration-failure.js";
import { describe, expect, it } from "vitest";
import { lifecycleFailureCode, markVerificationFailure, verificationFailureSubstage, withPreservedFailure } from "./lifecycle-verification-diagnostics.js";
import { HttpError } from "../errors.js";

describe("safe lifecycle verification diagnostics", () => {
  it.each([
    [new HttpError(422, "private payload", { code: "ai_connection_incompatible" }), "ai_connection_incompatible"],
    [{ details: { code: "ai_connection_credential_not_shared" } }, "ai_connection_credential_not_shared"],
    [{ cause: new HttpError(403, "private payload", { code: "ai_connection_credential_not_shared" }) }, "ai_connection_credential_not_shared"],
    [{ cause: { code: "EACCES" } }, "EACCES"],
    [{ code: "private", details: { code: "private" }, cause: { details: { code: "private" } } }, "unclassified"],
    [aiConnectionCredentialNotSharedFailure(), "ai_connection_credential_not_shared"],
    [{ cause: aiConnectionCredentialNotSharedFailure() }, "ai_connection_credential_not_shared"],
    [null, "unclassified"],
    ["private payload", "unclassified"],
  ])("only exposes allowlisted codes", (error, code) => {
    expect(lifecycleFailureCode(error)).toBe(code);
  });
  it("keeps the provider failure and substage through failed cleanup", async () => {
    const original = new HttpError(422, "private payload", { code: "ai_connection_incompatible" });
    markVerificationFailure(original, "provider_test");
    await expect(withPreservedFailure(async () => { throw original; }, async () => {
      markVerificationFailure(original, "cleanup_release");
      throw new Error("private cleanup payload");
    })).rejects.toBe(original);
    expect(verificationFailureSubstage(original)).toBe("provider_test");
  });
  it("reports cleanup failure when verification succeeds", async () => {
    const cleanup = Object.assign(new Error("private cleanup payload"), { code: "EACCES" });
    await expect(withPreservedFailure(async () => "complete", async () => { throw cleanup; })).rejects.toBe(cleanup);
  });
  it("preserves even an undefined rejection and still releases", async () => {
    let released = false;
    await expect(withPreservedFailure(async () => { throw undefined; }, async () => {
      released = true; throw new Error("cleanup");
    })).rejects.toBeUndefined();
    expect(released).toBe(true);
  });
});
