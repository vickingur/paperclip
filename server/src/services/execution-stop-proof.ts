import { and, eq } from "drizzle-orm";
import { environmentLeases, heartbeatRuns, type Db } from "@paperclipai/db";
import { hasNativeLocalProcessStop, hasHistoricalSuspendedNativeSession } from "./native-local-process-stop.js";
import { completeTerminatedRemoteNativeSessionCleanup } from "../vendor/paperclip-runner/index.js";
import { hasRemoteTerminationReceipt, remoteLeaseCleanupScope } from "./remote-execution-termination.js";

type StoppedSession = { evidence: Record<string, unknown>; retire: () => boolean };
export type ExecutionStopProof = { ok: true; stoppedSession?: StoppedSession } |
  { ok: false; reason: string; message: string };

function processStopped(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}

/** Shared environment proof only. Callers retain controller/finalizer locks,
 * outcome evidence, workspace, pause, authority and replacement-claim checks.
 * A never-dispatched exemption must already be proven by the caller. */
export async function verifyStoppedExecutionEnvironment(input: {
  db: Db; companyId: string; run: typeof heartbeatRuns.$inferSelect;
  unusedAdmission: boolean; cancelledStartup: boolean; retry: boolean; dryRun?: boolean;
}): Promise<ExecutionStopProof> {
  const { db, companyId, run, unusedAdmission, cancelledStartup, retry } = input;
  const blocked = (reason: string, message: string): ExecutionStopProof => ({ ok: false, reason, message });
  const leases = await db.select()
    .from(environmentLeases).where(and(
      eq(environmentLeases.companyId, companyId), eq(environmentLeases.heartbeatRunId, run.id),
    ));
  const remote = leases.some(lease => lease.provider !== "local");
  if (remote) {
    // Never interpret remote PIDs using the control-plane host's process table.
    if (!leases.every(hasRemoteTerminationReceipt)) return blocked("remote_cleanup", "Waiting for the previous environment to stop. Your message will start automatically.");
    if (run.runtimeMode === "native" && !input.dryRun && !leases.every(lease => completeTerminatedRemoteNativeSessionCleanup({
      companyId, runId: run.id, remoteCleanupScope: remoteLeaseCleanupScope(lease)!,
    }))) return blocked("remote_cleanup", "Verified remote session cleanup is unavailable.");
  } else {
    if (leases.some(lease => !lease.releasedAt || lease.cleanupStatus === "failed")) return blocked("local_cleanup", "Waiting for the previous environment to finish cleanup. Your message will start automatically.");
    if (!unusedAdmission && !cancelledStartup) {
      // A missing process identity is not evidence that a provider exited.
      if (!run.processPid && !run.processGroupId &&
          !await hasNativeLocalProcessStop(db, companyId, run.id) &&
          !await hasHistoricalSuspendedNativeSession(db, run)) return blocked("process_identity_missing", "The previous run has no verified stop record. Paperclip cannot start this message yet.");
      if (run.processPid && !processStopped(run.processPid)) return blocked("process_running", "Waiting for the previous process to stop. Your message will start automatically.");
      if (run.processGroupId && !processStopped(-run.processGroupId)) return blocked("process_running", "Waiting for the previous process to stop. Your message will start automatically.");
    }
  }
  if (!remote && run.runtimeMode === "native" && run.errorCode === "native_session_cleanup_quarantined") {
    // This is new user input, never permission to retry the interrupted turn.
    if (retry) return blocked("cleanup_quarantined", "Send a new message after the previous provider has stopped.");
    const { verifyStoppedNativeSessionForContinuation } = await import("./native-runtime/native-session-executor.js");
    const stopped = await verifyStoppedNativeSessionForContinuation(db, run);
    if (!stopped) return blocked("local_cleanup", "Waiting for the previous provider and its tools to stop. Your message is saved.");
    return { ok: true, stoppedSession: stopped };
  }
  return { ok: true };
}
