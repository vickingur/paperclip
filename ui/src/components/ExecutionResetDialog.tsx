import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { ExecutionResetInspection, ExecutionResetRequest, ExecutionResetCommittedResponse } from "@paperclipai/shared";
import { Copy, Loader2, RefreshCw, TriangleAlert } from "lucide-react";
import { issuesApi } from "@/api/issues";
import { ApiError } from "@/api/client";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogTrigger } from "@/components/ui/dialog";

type ResetContext = { issueId: string; agentId: string | null; allowed: boolean; pauseReason: string | null; onQueued: () => void };
const Context = createContext<ResetContext | null>(null);
export function ExecutionResetProvider({ value, children }: { value: ResetContext; children: ReactNode }) {
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useExecutionResetAccess() { return useContext(Context)?.allowed === true; }

const conflicts: Record<string, string> = {
  execution_reset_admission_rejected: "Reset wasn't admitted. The evidence may have changed, an action outcome may be unknown, or cleanup may be incomplete.",
  execution_reset_source_unavailable: "This task is closed, assigned to a person, or has no assigned agent.",
  execution_reset_source_changed: "The task's assignee or project changed after inspection.",
  execution_reset_company_unavailable: "The company isn't active.",
  execution_reset_agent_unavailable: "The assigned agent is unavailable.",
  execution_reset_worktree_execution_cutoff: "This task was created before the workspace execution cutoff and can't be reset here.",
  execution_reset_wake_on_demand_disabled: "The assigned agent doesn't accept on-demand runs.",
  execution_reset_idempotency_conflict: "This reset doesn't match the one already saved for this request. Inspect again before resetting.",
  execution_reset_receipt_mismatch: "This reset doesn't match the one already saved for this request. Inspect again before resetting.",
};
function accessMessage(status: number) {
  return status === 403 ? "Only board members can inspect an execution reset." : "This task isn't available. It may have been removed or you may no longer have access.";
}
function CopyValue({ value, label }: { value: string; label: string }) {
  const [error, setError] = useState(false);
  return <><Button variant="ghost" size="icon" aria-label={`Copy ${label}`} onClick={() => { void navigator.clipboard.writeText(value).catch(() => setError(true)); }}><Copy className="size-4" /></Button>{error && <span role="status">Couldn't copy. Select the value to copy it.</span>}</>;
}
function Hold({ hold, selected, disabled, onSelect, agentId }: { hold: ExecutionResetInspection["holds"][number]; selected: boolean; disabled: boolean; onSelect: () => void; agentId: string | null }) {
  const [expanded, setExpanded] = useState(false);
  return <div className="rounded-lg border p-3 space-y-2">
    <label className="flex items-start gap-2"><input className="shrink-0" type="radio" name="execution-reset-hold" checked={selected} disabled={disabled || !hold.holdingRunId} onChange={onSelect} /><span className="min-w-0">Execution hold · cause: <span className="font-mono break-all">{hold.cause}</span></span></label>
    <dl className="text-sm space-y-1">
      <div><dt>Recovery action</dt><dd className="font-mono break-all">{hold.recoveryActionId}<CopyValue value={hold.recoveryActionId} label="recovery action" /></dd></div>
      <div><dt>Holding run</dt><dd className="font-mono break-all">{hold.holdingRunId ? <>{agentId ? <Link to={`/agents/${agentId}/runs/${hold.holdingRunId}`}>{hold.holdingRunId}</Link> : hold.holdingRunId}<CopyValue value={hold.holdingRunId} label="holding run" /></> : "Not recorded"}</dd></div>
      <div><dt>Run status</dt><dd className="font-mono">{hold.runStatus ?? "Run record unavailable"}</dd></div>
      <div><dt>Outcome</dt><dd><Badge variant="secondary">{hold.outcomeClassification === "unknown" ? <><TriangleAlert className="size-4" />Unknown outcome</> : "Settled"}</Badge> {hold.actionCount === null ? "No action ledger was recorded. Effects can't be ruled out." : hold.actionCount === 0 ? "No recorded actions" : `${hold.actionCount} recorded actions${hold.outcomeClassification === "settled" ? ", all settled" : ""}`}{hold.evidenceIncomplete && <p>Evidence incomplete</p>}{!hold.sourceAvailable && <p>Source run unavailable</p>}</dd></div>
    </dl>
    {!hold.holdingRunId && <p>No holding run is recorded, so this hold can't be reset here.</p>}
    {hold.unknownActionIds.length > 0 && <div><p>Original actions with unknown outcome ({hold.unknownActionIds.length})</p><ul>{(expanded ? hold.unknownActionIds : hold.unknownActionIds.slice(0, 10)).map(id => <li className="font-mono break-all" key={id}>{id}</li>)}</ul>{hold.unknownActionIds.length > 10 && <Button variant="ghost" onClick={() => setExpanded(!expanded)}>{expanded ? "Show fewer" : `Show all ${hold.unknownActionIds.length}`}</Button>}</div>}
  </div>;
}

export function ExecutionResetEntry() {
  const context = useContext(Context);
  if (!context?.allowed) return null;
  return <ResetDialog context={context} />;
}
function ResetDialog({ context }: { context: ResetContext }) {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<"loading" | "ready" | "inspection-error" | "access" | "submitting" | "stale" | "uncertain" | "queued">("loading");
  const [snapshot, setSnapshot] = useState<ExecutionResetInspection | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [ack, setAck] = useState(false);
  const [message, setMessage] = useState("");
  const [result, setResult] = useState<ExecutionResetCommittedResponse | null>(null);
  const [closeConfirm, setCloseConfirm] = useState(false);
  const request = useRef<ExecutionResetRequest | null>(null);
  const busy = useRef(false);
  const generation = useRef(0);
  const title = useRef<HTMLHeadingElement>(null);
  const primary = useRef<HTMLButtonElement>(null);
  const evidenceBody = useRef<HTMLDivElement>(null);
  const reasonId = useId();
  const ackId = useId();
  useEffect(() => { if (["queued", "stale", "uncertain", "inspection-error"].includes(phase)) { primary.current?.focus(); if (evidenceBody.current) evidenceBody.current.scrollTop = 0; } }, [phase]);
  useEffect(() => () => { generation.current++; }, []);
  async function inspect() {
    const current = ++generation.current;
    request.current = null; setAck(false); setSelected(null); setSnapshot(null); setResult(null); setCloseConfirm(false); setPhase("loading");
    try {
      const data = await issuesApi.inspectExecutionReset(context.issueId);
      if (current !== generation.current) return;
      setSnapshot(data);
      const selectable = data.holds.filter(h => h.holdingRunId);
      setSelected(selectable.length === 1 ? selectable[0].recoveryActionId : null);
      setPhase("ready");
    } catch (error) {
      if (current !== generation.current) return;
      const access = error instanceof ApiError && [403, 404].includes(error.status);
      setMessage(access ? accessMessage((error as ApiError).status) : "Couldn't load execution evidence.");
      setPhase(access ? "access" : "inspection-error");
    }
  }
  function close(force = false) {
    if (busy.current) return;
    if (phase === "uncertain" && !force) { setCloseConfirm(true); return; }
    generation.current++; request.current = null; setOpen(false); setSnapshot(null);
    if (phase === "queued") context.onQueued();
  }
  const unknown = snapshot?.holds.some(h => h.outcomeClassification === "unknown");
  const reason = context.pauseReason ?? (unknown ? "Reset is unavailable while any action outcome is unknown. Reconcile the listed actions first, then inspect again." : null);
  const hold = snapshot?.holds.find(h => h.recoveryActionId === selected);
  async function submit() {
    if (busy.current) return;
    if (!request.current) {
      if (phase !== "ready" || reason || !ack || !snapshot || !hold?.holdingRunId) return;
      request.current = Object.freeze({ idempotencyKey: `board-reset:${crypto.randomUUID()}`, expectedHoldingRunId: hold.holdingRunId, expectedRecoveryActionId: hold.recoveryActionId, fingerprint: snapshot.fingerprint, acknowledgeFreshHistoryAwareTurn: true });
    }
    busy.current = true; setPhase("submitting"); setCloseConfirm(false);
    try {
      const response = await issuesApi.resetExecution(context.issueId, request.current);
      request.current = null; setResult(response); setPhase("queued");
    } catch (error) {
      if (error instanceof ApiError && error.status < 500) {
        request.current = null; setAck(false); setSelected(null);
        if ([403, 404].includes(error.status)) { setMessage(accessMessage(error.status)); setPhase("access"); }
        else {
          setMessage(error.status === 409 ? `${conflicts[error.message] ?? `Reset was blocked: ${error.message}`} Inspect current evidence to continue.` : "The reset request was rejected as invalid. Inspect again.");
          setPhase("stale");
        }
      } else {
        setMessage("We couldn't confirm whether the reset was saved. Retrying sends the same request, so it can't queue a second run."); setPhase("uncertain");
      }
    } finally { busy.current = false; }
  }
  const noHold = phase === "ready" && snapshot?.holds.length === 0;
  const closeOnly = phase === "access" || phase === "queued" || noHold;
  return <Dialog open={open} onOpenChange={next => { if (next) { setOpen(true); void inspect(); } else close(); }}>
    <DialogTrigger asChild><Button variant="outline" size="sm"><RefreshCw className="size-4" />Inspect reset…</Button></DialogTrigger>
    <DialogContent showCloseButton={false} className="flex flex-col max-h-(--execution-reset-max-height)" onOpenAutoFocus={event => { event.preventDefault(); title.current?.focus(); }} onEscapeKeyDown={event => { if (busy.current || phase === "uncertain") { event.preventDefault(); if (!busy.current) setCloseConfirm(true); } }}>
      <DialogTitle ref={title} tabIndex={-1}>Execution reset</DialogTitle>
      <DialogDescription>{phase === "queued" ? "Review the queued reset below." : "Review what stopped this task before starting a fresh run. Inspection shows recorded evidence; the server checks it again when you reset."}</DialogDescription>
      <div ref={evidenceBody} className="min-h-0 overflow-y-auto space-y-3">
        {phase === "loading" && <><p role="status">Checking current execution evidence…</p><Skeleton className="h-24" /><Skeleton className="h-24" /></>}
        {reason && phase === "ready" && !noHold && <p id={reasonId} role="status">{reason}</p>}
        {["access", "inspection-error", "stale", "uncertain"].includes(phase) && <p role="alert">{message}</p>}
        {phase === "queued" && result ? <div role="status" className="space-y-3"><h3>Reset queued</h3><Badge variant="secondary">Queued</Badge><p>A fresh, history-aware run is queued. Open the run to follow its status.</p><dl className="font-mono break-all"><dt>Queued run</dt><dd>{context.agentId ? <Link to={`/agents/${context.agentId}/runs/${result.successorRunId}`}>{result.successorRunId}</Link> : result.successorRunId}</dd><dt>Previous run</dt><dd>{result.previousRunId}</dd><dt>Reset</dt><dd>{result.resetId}</dd></dl></div> : phase !== "access" && snapshot && <div aria-disabled={phase !== "ready"} className={phase === "stale" ? "opacity-50 space-y-3" : "space-y-3"}><p className="font-mono text-sm">Evidence fingerprint {snapshot.fingerprint.slice(0, 6)}…{snapshot.fingerprint.slice(-4)}<CopyValue value={snapshot.fingerprint} label="evidence fingerprint" /></p>{snapshot.holds.map(h => <Hold key={h.recoveryActionId} hold={h} selected={selected === h.recoveryActionId} disabled={phase !== "ready"} agentId={context.agentId} onSelect={() => { setSelected(h.recoveryActionId); setAck(false); request.current = null; }} />)}</div>}
        {noHold && <p>No execution hold. Nothing on this task is waiting for a reset.</p>}
        {phase === "ready" && !noHold && <div className="space-y-2"><div className="flex items-center gap-2"><Checkbox id={ackId} checked={ack} disabled={!!reason} onCheckedChange={checked => { setAck(checked === true); request.current = null; }} /><Label htmlFor={ackId}>Start a fresh, history-aware run</Label></div><p className="text-sm text-muted-foreground">The agent starts a new session without the previous session's memory. It continues from this task's history, comments and documents.</p></div>}
        {closeConfirm && <div role="alert"><p>The reset may have been saved. If you close now, inspect again before trying another reset.</p><Button variant="ghost" onClick={() => setCloseConfirm(false)}>Keep open</Button><Button variant="outline" onClick={() => close(true)}>Close anyway</Button></div>}
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
        {closeOnly ? <Button ref={primary} className="mx-auto" onClick={() => close()}>{phase === "queued" ? "Done" : "Close"}</Button> : <><Button variant="ghost" disabled={phase === "submitting"} onClick={() => close()}>Cancel</Button><div className="flex flex-wrap gap-2">{phase === "uncertain" && <Button variant="outline" onClick={() => void inspect()}>Inspect again</Button>}<Button ref={primary} aria-describedby={reason ? reasonId : undefined} disabled={phase === "loading" || phase === "submitting" || (phase === "ready" && (!ack || !hold?.holdingRunId || !!reason))} onClick={() => { if (["stale", "inspection-error"].includes(phase)) void inspect(); else void submit(); }}>{phase === "submitting" ? <><Loader2 className="size-4 animate-spin" />Resetting…</> : phase === "uncertain" ? "Retry same request" : phase === "stale" ? "Inspect again" : phase === "inspection-error" ? "Try again" : "Reset execution"}</Button></div></>}
      </div>
    </DialogContent>
  </Dialog>;
}
