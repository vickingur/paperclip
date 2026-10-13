import { createHash } from "node:crypto";
import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import { environmentLeases, heartbeatRuns, issues, issueRecoveryActions,
  nativeRunFinalizations, type Db } from "@paperclipai/db";
import type { ExecutionResetInspection } from "@paperclipai/shared";
import { hasSettledExecutionActions } from "@paperclipai/adapter-utils/execution-action-inventory";
import { executionBlockerPredicate } from "./execution-blocker.js";

/** Canonical object order; array order remains significant (action history).
 * Hash retained evidence without returning arbitrary provider data to clients. */
export function executionResetFingerprint(value: unknown): string {
  function canonical(entry: unknown): unknown {
    if (entry instanceof Date) return entry.toISOString();
    if (Array.isArray(entry)) return entry.map(canonical);
    if (entry && typeof entry === "object") return Object.fromEntries(
      Object.entries(entry).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]),
    );
    return entry;
  }
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

export function classifyResetActions(value: unknown) {
  const settled = hasSettledExecutionActions(value);
  const raw = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
  const actions = Array.isArray(raw?.actions) ? raw.actions : null;
  // Preserve original IDs even if the ledger is incomplete/contradictory. In
  // that case every listed action is uncertain; this never certifies no effects.
  const unknownActionIds = settled ? [] : [...new Set((actions ?? []).flatMap(action =>
    action && typeof action === "object" && typeof action.id === "string" &&
    action.id.length > 0 && action.id.length <= 1024 ? [action.id] : [],
  ))];
  return {
    outcomeClassification: settled ? "settled" as const : "unknown" as const,
    unknownActionIds,
    actionCount: actions?.length ?? null,
    evidenceIncomplete: !settled,
  };
}

/** Call with a repeatable-read transaction for a coherent board preview, or
 * with reset's issue-locked transaction for the final fingerprint comparison.
 * This collects persisted evidence only: no cleanup, lease retirement, provider
 * calls or assertions of runtime safety. Admission must separately revalidate
 * current stop/cleanup, startup, ownership, gate and history proofs. */
export async function collectExecutionResetInspection(
  db: Db, companyId: string, issueId: string,
): Promise<ExecutionResetInspection | null> {
  const [task] = await db.select().from(issues).where(and(
    eq(issues.companyId, companyId), eq(issues.id, issueId),
  ));
  if (!task) return null;
  const holds = await db.select().from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, companyId), eq(issueRecoveryActions.sourceIssueId, issueId),
    executionBlockerPredicate(),
  )).orderBy(asc(issueRecoveryActions.id));
  const sourceIds = [...new Set(holds.flatMap(hold => {
    const parsed = z.string().guid().safeParse(hold.evidence.runId ?? hold.evidence.sourceRunId);
    return parsed.success ? [parsed.data] : [];
  }))];
  // Include competing active/checkout holders in the fingerprint even when
  // they have no recovery row. Never fetch another issue's run as a source.
  const runRows = await db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, companyId),
    or(eq(heartbeatRuns.nativeIssueId, issueId), sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issueId}`),
    or(sourceIds.length ? inArray(heartbeatRuns.id, sourceIds) : undefined,
      inArray(heartbeatRuns.status, ["queued", "running", "scheduled_retry"]),
      task.executionRunId ? eq(heartbeatRuns.id, task.executionRunId) : undefined,
      task.checkoutRunId ? eq(heartbeatRuns.id, task.checkoutRunId) : undefined),
  )).orderBy(asc(heartbeatRuns.id));
  const runIds = runRows.map(run => run.id);
  const finalizations = runIds.length ? await db.select().from(nativeRunFinalizations).where(and(
    eq(nativeRunFinalizations.companyId, companyId), eq(nativeRunFinalizations.issueId, issueId),
    inArray(nativeRunFinalizations.runId, runIds),
  )).orderBy(asc(nativeRunFinalizations.runId)) : [];
  const leases = await db.select().from(environmentLeases).where(and(
    eq(environmentLeases.companyId, companyId),
    or(eq(environmentLeases.issueId, issueId),
      runIds.length ? inArray(environmentLeases.heartbeatRunId, runIds) : undefined),
  )).orderBy(asc(environmentLeases.id));
  const byId = new Map(runRows.map(run => [run.id, run]));
  return {
    schema: "paperclip.execution-reset-inspection.v1", issueId,
    fingerprint: executionResetFingerprint({ companyId, task, holds, runRows, finalizations, leases }),
    continuationMode: "fresh_history_aware", validation: "required_at_reset",
    holds: holds.map(hold => {
      const parsed = z.string().guid().safeParse(hold.evidence.runId ?? hold.evidence.sourceRunId);
      const holdingRunId = parsed.success ? parsed.data : null;
      const run = holdingRunId ? byId.get(holdingRunId) : undefined;
      return { recoveryActionId: hold.id, holdingRunId, cause: hold.cause,
        runStatus: run?.status ?? null, sourceAvailable: Boolean(run),
        ...classifyResetActions(run?.resultJson?.executionActionInventory) };
    }),
  };
}

export async function inspectExecutionReset(db: Db, companyId: string, issueId: string) {
  return db.transaction(tx => collectExecutionResetInspection(tx as unknown as Db, companyId, issueId),
    { isolationLevel: "repeatable read", accessMode: "read only" });
}
