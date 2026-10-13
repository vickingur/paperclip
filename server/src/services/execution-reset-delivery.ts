import { and, eq } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import type { ExecutionResetCommittedResponse, ExecutionResetIntent } from "./execution-reset-idempotency.js";

/** Delivery is outside the reset transaction. A failed notification or start
 * cannot turn an already committed reset into a failed API response. Queued
 * runs remain durable for retry and the ordinary startup resume scan. */
export async function deliverExecutionReset(
  db: Db,
  intent: ExecutionResetIntent,
  commit: () => Promise<ExecutionResetCommittedResponse>,
  effects: {
    publish: (run: typeof heartbeatRuns.$inferSelect) => void;
    start: (agentId: string) => Promise<unknown>;
    failed: (error: unknown, response: ExecutionResetCommittedResponse) => void;
  },
) {
  const response = await commit();
  try {
    const [run] = await db.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, intent.companyId),
      eq(heartbeatRuns.id, response.successorRunId),
    ));
    // Terminal retries replay the response without producing another event.
    if (run?.status === "queued") {
      try { effects.publish(run); }
      catch (error) { effects.failed(error, response); }
      await effects.start(run.agentId);
    }
  } catch (error) { effects.failed(error, response); }
  return response;
}
