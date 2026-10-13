/** Inspection is evidence, never authorization or proof that reset may run. */
export interface ExecutionResetInspection {
  schema: "paperclip.execution-reset-inspection.v1";
  issueId: string;
  fingerprint: string;
  continuationMode: "fresh_history_aware";
  validation: "required_at_reset";
  holds: Array<{
    recoveryActionId: string;
    holdingRunId: string | null;
    cause: string;
    runStatus: string | null;
    sourceAvailable: boolean;
    outcomeClassification: "settled" | "unknown";
    unknownActionIds: string[];
    actionCount: number | null;
    evidenceIncomplete: boolean;
  }>;
}
