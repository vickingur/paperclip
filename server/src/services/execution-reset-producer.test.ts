import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agents, agentWakeupRequests, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { commitExecutionReset } from "./execution-reset-producer.js";
import { executionResetIdentity, type ExecutionResetIntent } from "./execution-reset-idempotency.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("atomic reset producer (synthetic admission)", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("reset-producer-"); db = createDb(database.connectionString); }, 90_000);
  afterAll(async () => { await database?.cleanup(); });
  async function seed() {
    const companyId = randomUUID(), issueId = randomUUID(), agentId = randomUUID();
    const intent: ExecutionResetIntent = { companyId, issueId, principalId: "synthetic-board", idempotencyKey: "reset",
      expectedHoldingRunId: randomUUID(), expectedRecoveryActionId: randomUUID(), fingerprint: "synthetic-proof",
      acknowledgeFreshHistoryAwareTurn: true };
    await db.insert(companies).values({ id: companyId, name: "Synthetic producer", issuePrefix: `P${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Synthetic owner", role: "engineer", adapterType: "process" });
    await db.insert(issues).values({ id: issueId, companyId, title: "held", status: "in_progress", assigneeAgentId: agentId });
    const admit = vi.fn(async ({ db: tx }: Parameters<Parameters<typeof commitExecutionReset>[2]>[0]) => {
      // Models a durable admission mutation; these tests do not certify policy,
      // stopped process cleanup or authenticated route/dispatch authorization.
      await tx.update(issues).set({ title: "admitted" }).where(eq(issues.id, issueId));
      return { previousRunId: intent.expectedHoldingRunId };
    });
    return { intent, admit, agentId };
  }
  async function rows(intent: ExecutionResetIntent) {
    return {
      requests: await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, intent.companyId)),
      runs: await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, intent.companyId)),
      issue: (await db.select().from(issues).where(eq(issues.id, intent.issueId)))[0],
    };
  }
  it("commits one receipt and successor; replays after completion without admission", async () => {
    const f = await seed();
    const response = await commitExecutionReset(db, f.intent, f.admit);
    const stored = await rows(f.intent);
    expect(stored.issue.title).toBe("admitted");
    expect(stored.requests).toHaveLength(1); expect(stored.runs).toHaveLength(1);
    expect(stored.requests[0].runId).toBe(response.successorRunId);
    expect(stored.runs[0].wakeupRequestId).toBe(response.resetId);
    expect(stored.runs[0].sessionIdBefore).toBeNull();
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, response.successorRunId));
    await db.update(issues).set({ status: "done", assigneeAgentId: null }).where(eq(issues.id, f.intent.issueId));
    expect(await commitExecutionReset(db, f.intent, f.admit)).toEqual(response);
    expect(f.admit).toHaveBeenCalledTimes(1);
  });
  it("serializes concurrent same-key retries before admission", async () => {
    const f = await seed();
    const result = await Promise.all([1, 2, 3].map(() => commitExecutionReset(db, f.intent, f.admit)));
    expect(result[1]).toEqual(result[0]); expect(result[2]).toEqual(result[0]);
    expect(f.admit).toHaveBeenCalledTimes(1);
    const stored = await rows(f.intent);
    expect(stored.requests).toHaveLength(1); expect(stored.runs).toHaveLength(1);
  });
  it("rejects changed payload before repeating admission", async () => {
    const f = await seed(); await commitExecutionReset(db, f.intent, f.admit);
    await expect(commitExecutionReset(db, { ...f.intent, fingerprint: "altered" }, f.admit)).rejects.toThrow("idempotency_conflict");
    expect(f.admit).toHaveBeenCalledTimes(1);
  });
  it.each(["reject", "throw", "wrongPredecessor", "insertFailure"])("rolls back admission and receipt on %s", async failure => {
    const f = await seed();
    await expect(commitExecutionReset(db, f.intent, async input => {
      const admission = await f.admit(input);
      if (failure === "reject") return null;
      if (failure === "throw") throw new Error("synthetic failure");
      if (failure === "wrongPredecessor") return { previousRunId: randomUUID() };
      // Force a successor primary-key violation after the reset receipt write.
      await input.db.insert(heartbeatRuns).values({ id: input.successorRunId,
        companyId: f.intent.companyId, agentId: f.agentId, status: "queued" });
      return admission;
    })).rejects.toThrow();
    const stored = await rows(f.intent);
    expect(stored.issue.title).toBe("held");
    expect(stored.requests).toHaveLength(0); expect(stored.runs).toHaveLength(0);
    await expect(commitExecutionReset(db, f.intent, f.admit)).resolves.toMatchObject({ issueId: f.intent.issueId });
  });
  it("does not treat an incomplete existing receipt as a fresh attempt", async () => {
    const f = await seed();
    await db.insert(agentWakeupRequests).values({ companyId: f.intent.companyId, agentId: f.agentId,
      source: "on_demand", reason: "execution_reset", status: "failed",
      idempotencyKey: executionResetIdentity(f.intent).scopedKey });
    await expect(commitExecutionReset(db, f.intent, f.admit)).rejects.toThrow();
    expect(f.admit).not.toHaveBeenCalled();
  });
  it("remains atomic inside a caller-owned transaction", async () => {
    const f = await seed();
    await expect(db.transaction(async tx => {
      await commitExecutionReset(tx as unknown as typeof db, f.intent, f.admit);
      throw new Error("outer rollback");
    })).rejects.toThrow("outer rollback");
    const stored = await rows(f.intent);
    expect(stored.issue.title).toBe("held");
    expect(stored.requests).toHaveLength(0); expect(stored.runs).toHaveLength(0);
    await expect(commitExecutionReset(db, f.intent, f.admit)).resolves.toMatchObject({ issueId: f.intent.issueId });
  });
  it("cannot admit a foreign-company issue", async () => {
    const f = await seed();
    await expect(commitExecutionReset(db, { ...f.intent, companyId: randomUUID() }, f.admit)).rejects.toThrow("source_unavailable");
    expect(f.admit).not.toHaveBeenCalled();
  });
});
