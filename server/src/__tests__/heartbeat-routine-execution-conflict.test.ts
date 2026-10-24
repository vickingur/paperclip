import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  bindRoutineExecutionLock,
  noOtherRoutineExecutionLockHolder,
} from "../services/routine-execution-lock.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Routine execution conflict test run.",
    provider: "test",
    model: "test-model",
  })),
);

// Lets a test skip the pre-claim lock-holder check, so the claim reaches the
// database constraint the way a concurrent claim would.
const lockHolderLookup = vi.hoisted(() => ({ bypass: false }));

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

vi.mock("../services/routine-execution-lock.js", async () => {
  const actual = await vi.importActual<typeof import("../services/routine-execution-lock.js")>(
    "../services/routine-execution-lock.js",
  );
  return {
    ...actual,
    findRoutineExecutionLockHolder: vi.fn((...args: Parameters<typeof actual.findRoutineExecutionLockHolder>) =>
      lockHolderLookup.bypass ? Promise.resolve(null) : actual.findRoutineExecutionLockHolder(...args)),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres routine execution conflict tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat routine execution lock conflicts", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let heartbeat!: ReturnType<typeof heartbeatService>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-routine-execution-conflict-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 20_000);

  afterEach(async () => {
    lockHolderLookup.bypass = false;
    await heartbeat.drainActiveRunExecutions();
    mockAdapterExecute.mockClear();
    runningProcesses.clear();
    await db.execute(sql`truncate table ${companies} cascade`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  // Two open execution issues of one routine, as left by the incident: the
  // older one still holds a stale execution run, the newer one is idle.
  async function seedDuplicateRoutineIssues() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const routineId = randomUUID();
    const staleRunId = randomUUID();
    const prefix = `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Routine Conflict Co",
      status: "active",
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Routine Conflict Agent",
      role: "ceo",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: { enabled: true, intervalSec: 60, wakeOnDemand: true, maxConcurrentRuns: 1 },
      },
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: staleRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "failed",
      finishedAt: new Date(Date.now() - 60 * 60_000),
    });

    const holderIssueId = randomUUID();
    const duplicateIssueId = randomUUID();
    const routineIssue = {
      companyId,
      title: "Daily org efficiency review",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      originKind: "routine_execution",
      originId: routineId,
      originFingerprint: "default",
    } as const;
    await db.insert(issues).values([
      {
        ...routineIssue,
        id: holderIssueId,
        identifier: `${prefix}-1`,
        issueNumber: 1,
        executionRunId: staleRunId,
        executionLockedAt: new Date(Date.now() - 60 * 60_000),
      },
      { ...routineIssue, id: duplicateIssueId, identifier: `${prefix}-2`, issueNumber: 2 },
    ]);

    return { companyId, agentId, holderIssueId, duplicateIssueId, staleRunId, holderIdentifier: `${prefix}-1` };
  }

  async function insertQueuedIssueRun(companyId: string, agentId: string, issueId: string, createdAt: Date) {
    const wakeupRequestId = randomUUID();
    const runId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "on_demand",
      triggerDetail: "manual",
      reason: "issue_assigned",
      status: "queued",
      runId,
      requestedByActorType: "user",
      requestedByActorId: "board-user",
      payload: { issueId, manualUserWake: true },
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
      createdAt,
    });
    return runId;
  }

  async function runRow(runId: string) {
    return db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode, error: heartbeatRuns.error })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
  }

  async function executionRunIdOf(issueId: string) {
    return db
      .select({ executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]?.executionRunId ?? null);
  }

  // Holds an uncommitted bind of `issueId` until the returned commit() is
  // called, so a concurrent bind of a duplicate issue passes its NOT EXISTS
  // guard and then waits on the unique index.
  async function holdUncommittedBind(issueId: string, runId: string) {
    let commit!: () => void;
    let bound!: () => void;
    const gate = new Promise<void>((resolve) => { commit = resolve; });
    const ready = new Promise<void>((resolve) => { bound = resolve; });
    const done = db.transaction(async (tx) => {
      await tx.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
      bound();
      await gate;
    });
    await ready;
    return { commit: async () => { commit(); await done; } };
  }

  async function waitForIssueUpdateLockWait() {
    for (let i = 0; i < 250; i++) {
      const rows = await db.execute(sql`
        select pid from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock' and query like 'update "issues"%'`);
      if (rows.length > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("concurrent issue bind never waited on the routine execution index");
  }

  it("keeps the enclosing transaction when a concurrent bind wins the routine lock", async () => {
    const { holderIssueId, duplicateIssueId, staleRunId } = await seedDuplicateRoutineIssues();
    await db.update(issues).set({ executionRunId: null }).where(eq(issues.id, holderIssueId));
    const holder = await holdUncommittedBind(holderIssueId, staleRunId);

    const enclosing = db.transaction(async (tx) => {
      const bound = await bindRoutineExecutionLock(tx as unknown as typeof db, (bindTx) => bindTx
        .update(issues)
        .set({ executionRunId: staleRunId })
        .where(sql`${issues.id} = ${duplicateIssueId} and ${noOtherRoutineExecutionLockHolder()}`));
      // The enclosing transaction must still accept writes after the lost race.
      await tx.update(issues).set({ title: "Released" }).where(eq(issues.id, duplicateIssueId));
      return bound;
    });
    try {
      await waitForIssueUpdateLockWait();
    } finally {
      await holder.commit();
    }

    await expect(enclosing).resolves.toBe(false);
    expect(await executionRunIdOf(duplicateIssueId)).toBeNull();
    expect(await executionRunIdOf(holderIssueId)).toBe(staleRunId);
    const [released] = await db.select({ title: issues.title }).from(issues).where(eq(issues.id, duplicateIssueId));
    expect(released?.title).toBe("Released");
  });

  it("completes a wakeup whose execution-lock adoption races a duplicate routine bind", async () => {
    const { companyId, agentId, holderIssueId, duplicateIssueId, staleRunId } = await seedDuplicateRoutineIssues();
    await db.update(issues).set({ executionRunId: null }).where(eq(issues.id, holderIssueId));
    // A queued run on the duplicate issue that never took the issue lock; the
    // wakeup's enqueue transaction adopts it as the execution run.
    const legacyRunId = await insertQueuedIssueRun(companyId, agentId, duplicateIssueId, new Date(Date.now() - 60_000));
    const holder = await holdUncommittedBind(holderIssueId, staleRunId);

    const wakeup = heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "issue_assigned",
      payload: { issueId: duplicateIssueId },
      contextSnapshot: { issueId: duplicateIssueId, taskId: duplicateIssueId, wakeReason: "issue_assigned" },
    });
    try {
      await waitForIssueUpdateLockWait();
    } finally {
      await holder.commit();
    }

    // Before the savepoint, the adoption raised the unique violation and the
    // whole enqueue transaction rolled back.
    await wakeup;
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();

    expect(await executionRunIdOf(duplicateIssueId)).toBeNull();
    expect(await executionRunIdOf(holderIssueId)).toBe(staleRunId);
    expect(await runRow(legacyRunId)).toMatchObject({
      status: "cancelled",
      errorCode: "routine_execution_superseded",
    });
    expect(mockAdapterExecute).not.toHaveBeenCalled();
  });

  it("supersedes a queued run on a duplicate routine issue during startup recovery", async () => {
    const { companyId, agentId, holderIssueId, duplicateIssueId, staleRunId, holderIdentifier } =
      await seedDuplicateRoutineIssues();
    const runId = await insertQueuedIssueRun(companyId, agentId, duplicateIssueId, new Date(Date.now() - 60_000));

    await expect(heartbeat.resumeQueuedRuns()).resolves.toBeUndefined();

    expect(await runRow(runId)).toMatchObject({
      status: "cancelled",
      errorCode: "routine_execution_superseded",
      error: `Cancelled because another open execution issue ${holderIdentifier} of this routine already holds its execution lock`,
    });
    expect(await executionRunIdOf(duplicateIssueId)).toBeNull();
    expect(await executionRunIdOf(holderIssueId)).toBe(staleRunId);
    expect(mockAdapterExecute).not.toHaveBeenCalled();

    // Recovery runs on every restart; the settled run must not fail it again.
    await expect(heartbeat.resumeQueuedRuns()).resolves.toBeUndefined();
  });

  it("supersedes the promoted run instead of failing a cancel", async () => {
    const { companyId, agentId, duplicateIssueId } = await seedDuplicateRoutineIssues();
    const cancelledRunId = await insertQueuedIssueRun(companyId, agentId, duplicateIssueId, new Date(Date.now() - 120_000));
    const promotedRunId = await insertQueuedIssueRun(companyId, agentId, duplicateIssueId, new Date(Date.now() - 60_000));

    await expect(heartbeat.cancelRun(cancelledRunId, "Cancelled by board")).resolves.toMatchObject({ status: "cancelled" });

    expect(await runRow(cancelledRunId)).toMatchObject({ status: "cancelled", errorCode: "cancelled" });
    expect(await runRow(promotedRunId)).toMatchObject({
      status: "cancelled",
      errorCode: "routine_execution_superseded",
    });
    expect(await executionRunIdOf(duplicateIssueId)).toBeNull();
    expect(mockAdapterExecute).not.toHaveBeenCalled();
  });

  it("supersedes a run whose claim hits the routine execution constraint", async () => {
    const { companyId, agentId, duplicateIssueId } = await seedDuplicateRoutineIssues();
    const runId = await insertQueuedIssueRun(companyId, agentId, duplicateIssueId, new Date(Date.now() - 60_000));
    lockHolderLookup.bypass = true;

    await expect(heartbeat.resumeQueuedRuns()).resolves.toBeUndefined();

    expect(await runRow(runId)).toMatchObject({
      status: "cancelled",
      errorCode: "routine_execution_superseded",
      error: "Cancelled because another open execution issue of this routine already holds its execution lock",
    });
    expect(await executionRunIdOf(duplicateIssueId)).toBeNull();
    expect(mockAdapterExecute).not.toHaveBeenCalled();
  });

  it("still claims a routine issue that holds no conflicting lock", async () => {
    const { companyId, agentId, holderIssueId } = await seedDuplicateRoutineIssues();
    const runId = await insertQueuedIssueRun(companyId, agentId, holderIssueId, new Date(Date.now() - 60_000));

    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();

    // The run is claimed and dispatched; its adapter outcome is irrelevant here.
    const claimed = await runRow(runId);
    expect(claimed?.status).not.toBe("queued");
    expect(claimed?.errorCode).not.toBe("routine_execution_superseded");
  });
});
