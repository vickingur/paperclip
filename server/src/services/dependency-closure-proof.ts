import { createHash } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { activityLog, issueRelations, issues, type Db } from "@paperclipai/db";
import { isUuidLike } from "@paperclipai/shared";
import { persistActivity } from "./activity-log.js";
import { issueService } from "./issues.js";

const ACTION = "issue.dependency_closure_verified";
const SCHEMA = "paperclip.dependency-closure.v1";
export const DEPENDENCY_CLOSURE_RECEIPT_KEY = "dependencyClosureReceiptId";

type Scope = { companyId: string; issueId: string; agentId: string };

/** Read authoritative edges, including their identities. Removing/recreating an
 * edge, reopening a blocker or changing the blocked cycle invalidates a receipt.
 * Must be rechecked under the ordinary issue execution lock before admission. */
async function currentClosure(db: Db, scope: Scope, resolvedBlockerIssueId: string) {
  const [task] = await db.select().from(issues).where(and(
    eq(issues.companyId, scope.companyId), eq(issues.id, scope.issueId),
  ));
  if (!task || task.assigneeAgentId !== scope.agentId || task.assigneeUserId ||
      ["done", "cancelled"].includes(task.status)) return null;
  const edges = await db.select({ id: issueRelations.id, blockerId: issues.id,
    status: issues.status, completedAt: issues.completedAt,
    edgeUpdatedAt: issueRelations.updatedAt,
  }).from(issueRelations).leftJoin(issues, and(
    eq(issues.companyId, scope.companyId), eq(issues.id, issueRelations.issueId),
  )).where(and(eq(issueRelations.companyId, scope.companyId),
    eq(issueRelations.relatedIssueId, scope.issueId), eq(issueRelations.type, "blocks"),
  )).orderBy(asc(issueRelations.id));
  if (!edges.length || !edges.some(edge => edge.blockerId === resolvedBlockerIssueId) ||
      edges.some(edge => edge.status !== "done" || !edge.completedAt)) return null;
  const readiness = await issueService(db).getDependencyReadiness(scope.issueId);
  if (!readiness.isDependencyReady) return null;
  return createHash("sha256").update(JSON.stringify({ companyId: scope.companyId, issueId: scope.issueId, agentId: scope.agentId,
    blockedTransitionAt: task.blockedTransitionAt?.toISOString() ?? null,
    edges: edges.map(edge => ({ id: edge.id, blockerId: edge.blockerId,
      completedAt: edge.completedAt!.toISOString(), edgeUpdatedAt: edge.edgeUpdatedAt.toISOString() })),
  })).digest("hex");
}

/** Internal producers call this only after observing a real dependency-ready
 * transition. No route accepts a caller-supplied fingerprint or actor as proof.
 * A missing proof leaves ordinary waking intact, but cannot retire recovery. */
export async function recordDependencyClosureProof(db: Db, input: Scope & {
  resolvedBlockerIssueId: string;
  producer: "issue_update" | "issue_comment" | "native_status_decision" | "dependency_backstop";
}): Promise<string | null> {
  const fingerprint = await currentClosure(db, input, input.resolvedBlockerIssueId);
  if (!fingerprint) return null;
  const { activity } = await persistActivity(db, { companyId: input.companyId,
    actorType: "system", actorId: "issue-dependencies", agentId: input.agentId,
    action: ACTION, entityType: "issue", entityId: input.issueId,
    details: { schema: SCHEMA, resolvedBlockerIssueId: input.resolvedBlockerIssueId,
      fingerprint, producer: input.producer },
  });
  return activity.id;
}

/** Receipt metadata is untrusted until the server-created activity and current
 * dependency state agree. Cross-company IDs and arbitrary wake reasons fail closed. */
export async function verifyDependencyClosureProof(db: Db, input: Scope & {
  receiptId: unknown;
}): Promise<{ receiptId: string; resolvedBlockerIssueId: string; fingerprint: string; createdAt: Date } | null> {
  if (typeof input.receiptId !== "string" || !isUuidLike(input.receiptId)) return null;
  const [receipt] = await db.select().from(activityLog).where(and(
    eq(activityLog.companyId, input.companyId), eq(activityLog.id, input.receiptId),
    eq(activityLog.agentId, input.agentId), eq(activityLog.entityType, "issue"),
    eq(activityLog.entityId, input.issueId), eq(activityLog.actorType, "system"),
    eq(activityLog.actorId, "issue-dependencies"), eq(activityLog.action, ACTION),
  ));
  const details = receipt?.details;
  if (!details || details.schema !== SCHEMA || typeof details.resolvedBlockerIssueId !== "string" || !isUuidLike(details.resolvedBlockerIssueId) ||
      typeof details.fingerprint !== "string") return null;
  const fingerprint = await currentClosure(db, input, details.resolvedBlockerIssueId);
  if (!fingerprint || fingerprint !== details.fingerprint) return null;
  const [blocker] = await db.select({ completedAt: issues.completedAt }).from(issues).where(and(
    eq(issues.companyId, input.companyId), eq(issues.id, details.resolvedBlockerIssueId), eq(issues.status, "done"),
  ));
  if (!blocker?.completedAt) return null;
  // A late backstop receipt cannot move the real closure past a newer stop.
  return { receiptId: receipt.id, resolvedBlockerIssueId: details.resolvedBlockerIssueId, fingerprint,
    createdAt: new Date(Math.min(receipt.createdAt.getTime(), blocker.completedAt.getTime())) };
}
