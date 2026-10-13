/** Local run-result evidence, never telemetry. ACP failures/cancellations do
 * not certify that a tool had no effect. Keep original IDs, without arguments,
 * titles, output or provider error text, for action-specific reconciliation. */
export interface ExecutionActionInventory {
  schema: "paperclip.execution-actions.v1";
  source: "acp";
  complete: boolean;
  dispatch: "not_attempted" | "attempted";
  noActionsConfirmed: boolean;
  actions: Array<{
    id: string;
    kind: string | null;
    status: string | null;
    outcome: "completed" | "unknown";
  }>;
}

const kinds = new Set(["read", "edit", "delete", "move", "search", "execute", "think", "fetch", "switch_mode", "other"]);
const statuses = new Set(["pending", "in_progress", "completed", "failed", "cancelled"]);
const terminal = new Set(["completed", "failed", "cancelled"]);

export function createExecutionActionInventory() {
  const actions = new Map<string, { kind: string | null; status: string | null; contradictory: boolean }>();
  let incomplete = false;
  return {
    invalidate() { incomplete = true; },
    observe(event: { toolCallId?: string; kind?: string; status?: string; tag?: string }) {
      const id = event.toolCallId;
      if (!id || id.length > 1024 || (!actions.has(id) && actions.size >= 4096)) {
        incomplete = true;
        return;
      }
      const previous = actions.get(id);
      // An update without the dispatch boundary cannot prove full coverage.
      if (!previous && event.tag === "tool_call_update") incomplete = true;
      const kind = event.kind && kinds.has(event.kind) ? event.kind : previous?.kind ?? null;
      const status = event.status && statuses.has(event.status) ? event.status : previous?.status ?? null;
      const contradictory = Boolean(previous?.contradictory ||
        (previous?.kind && event.kind && previous.kind !== event.kind) ||
        (previous?.status && terminal.has(previous.status) && event.status && previous.status !== event.status) ||
        (event.kind && !kinds.has(event.kind)) || (event.status && !statuses.has(event.status)));
      actions.set(id, { kind, status, contradictory });
    },
    snapshot(input: { dispatchAttempted: boolean; streamCompleted: boolean; turnCompleted: boolean }): ExecutionActionInventory {
      const complete = !incomplete && (!input.dispatchAttempted || input.streamCompleted);
      return {
        schema: "paperclip.execution-actions.v1", source: "acp", complete,
        dispatch: input.dispatchAttempted ? "attempted" : "not_attempted",
        noActionsConfirmed: complete && actions.size === 0 && (!input.dispatchAttempted || input.turnCompleted),
        actions: [...actions].map(([id, action]) => ({ id, kind: action.kind, status: action.status,
          outcome: action.kind && action.status === "completed" && !action.contradictory ? "completed" : "unknown" })),
      };
    },
  };
}

/** Strict consumer: old summary labels, missing ledgers and malformed evidence
 * remain unknown. The caller must separately prove termination and gate state. */
export function hasSettledExecutionActions(value: unknown): value is ExecutionActionInventory {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as ExecutionActionInventory;
  if (entry.schema !== "paperclip.execution-actions.v1" || entry.source !== "acp" || entry.complete !== true ||
      !["attempted", "not_attempted"].includes(entry.dispatch) || typeof entry.noActionsConfirmed !== "boolean" ||
      !Array.isArray(entry.actions) || entry.actions.length > 4096) return false;
  if (!entry.actions.length) return entry.noActionsConfirmed;
  if (entry.noActionsConfirmed || entry.dispatch !== "attempted") return false;
  const ids = new Set<string>();
  return entry.actions.every(action => {
    if (!action || typeof action.id !== "string" || !action.id || action.id.length > 1024 || ids.has(action.id) ||
        typeof action.kind !== "string" || !kinds.has(action.kind) || action.status !== "completed" ||
        action.outcome !== "completed") return false;
    ids.add(action.id);
    return true;
  });
}
