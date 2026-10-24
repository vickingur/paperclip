import { and, eq, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues } from "@paperclipai/db";
import { isUniqueViolation } from "../db-errors.js";

/**
 * `issues_open_routine_execution_uq` allows one open, visible execution issue per
 * routine dispatch key to hold `executionRunId`. Two open issues for the same key
 * can coexist while idle; the second one to bind an execution run violates the
 * index. Binding sites use these helpers so that a conflicting run is superseded
 * instead of failing the claim, a cancel, or startup recovery.
 */
export const ROUTINE_EXECUTION_LOCK_CONSTRAINT = "issues_open_routine_execution_uq";

// Must match the partial index predicate in packages/db/src/schema/issues.ts.
const ROUTINE_EXECUTION_LOCK_STATUSES = ["backlog", "todo", "in_progress", "in_review", "blocked"];

export const ROUTINE_EXECUTION_SUPERSEDED_ERROR_CODE = "routine_execution_superseded";

export function isRoutineExecutionLockConflict(error: unknown) {
  return isUniqueViolation(error, ROUTINE_EXECUTION_LOCK_CONSTRAINT);
}

/**
 * Update guard for `update issues set execution_run_id = ...`: true unless another
 * open execution issue of the same routine dispatch key already holds the lock.
 * The outer table is referenced by name, so use it only on updates of `issues`.
 */
export function noOtherRoutineExecutionLockHolder() {
  return sql`not exists (
    select 1 from "issues" as "routine_lock_holder"
    where "issues"."origin_kind" = 'routine_execution'
      and "routine_lock_holder"."company_id" = "issues"."company_id"
      and "routine_lock_holder"."origin_kind" = 'routine_execution'
      and "routine_lock_holder"."origin_id" = "issues"."origin_id"
      and "routine_lock_holder"."origin_fingerprint" = "issues"."origin_fingerprint"
      and "routine_lock_holder"."id" <> "issues"."id"
      and "routine_lock_holder"."hidden_at" is null
      and "routine_lock_holder"."execution_run_id" is not null
      and "routine_lock_holder"."status" in ('backlog', 'todo', 'in_progress', 'in_review', 'blocked')
  )`;
}

/**
 * Runs a guarded `execution_run_id` bind in a savepoint. The NOT EXISTS guard
 * reads a snapshot, so a concurrent bind of a duplicate issue can commit while
 * this update waits on the unique index, and the update then raises the
 * violation anyway. Rolling back only the savepoint keeps the caller's release,
 * promotion or enqueue transaction intact; the run stays unbound and its claim
 * supersedes it. Returns false when the bind lost that race.
 */
export async function bindRoutineExecutionLock(executor: Db, bind: (tx: Db) => Promise<unknown>) {
  try {
    await executor.transaction(async (tx) => {
      await bind(tx as unknown as Db);
    });
    return true;
  } catch (error) {
    if (isRoutineExecutionLockConflict(error)) return false;
    throw error;
  }
}

/**
 * Returns the other open execution issue of the same routine dispatch key that
 * holds the execution lock, or null when `issueId` could bind an execution run.
 */
export async function findRoutineExecutionLockHolder(db: Db, companyId: string, issueId: string) {
  const [issue] = await db
    .select({
      originKind: issues.originKind,
      originId: issues.originId,
      originFingerprint: issues.originFingerprint,
      hiddenAt: issues.hiddenAt,
      status: issues.status,
    })
    .from(issues)
    .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)));
  if (
    !issue ||
    issue.originKind !== "routine_execution" ||
    !issue.originId ||
    !issue.originFingerprint ||
    issue.hiddenAt ||
    !ROUTINE_EXECUTION_LOCK_STATUSES.includes(issue.status)
  ) {
    return null;
  }
  const [holder] = await db
    .select({ id: issues.id, identifier: issues.identifier, executionRunId: issues.executionRunId })
    .from(issues)
    .where(and(
      eq(issues.companyId, companyId),
      eq(issues.originKind, "routine_execution"),
      eq(issues.originId, issue.originId),
      eq(issues.originFingerprint, issue.originFingerprint),
      ne(issues.id, issueId),
      isNull(issues.hiddenAt),
      isNotNull(issues.executionRunId),
      inArray(issues.status, ROUTINE_EXECUTION_LOCK_STATUSES),
    ))
    .limit(1);
  return holder ?? null;
}
