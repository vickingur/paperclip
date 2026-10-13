import { useLayoutEffect } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ExecutionResetInspection } from "@paperclipai/shared";
import { ExecutionResetEntry, ExecutionResetProvider } from "@/components/ExecutionResetDialog";
import { issuesApi } from "@/api/issues";
import { ApiError } from "@/api/client";

type State = "ready" | "unknown" | "queued" | "stale" | "uncertain";
const issueId = "00000000-0000-4000-8000-000000000001";
const inspection: ExecutionResetInspection = {
  schema: "paperclip.execution-reset-inspection.v1", issueId,
  fingerprint: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  continuationMode: "fresh_history_aware", validation: "required_at_reset",
  holds: [{ recoveryActionId: "00000000-0000-4000-8000-000000000002",
    holdingRunId: "00000000-0000-4000-8000-000000000003", cause: "legacy_execution_requires_reconciliation",
    runStatus: "cancelled", sourceAvailable: true, outcomeClassification: "settled",
    unknownActionIds: [], actionCount: 3, evidenceIncomplete: false }],
};
function Fixture({ state }: { state: State }) {
  useLayoutEffect(() => {
    const originalInspect = issuesApi.inspectExecutionReset;
    const originalReset = issuesApi.resetExecution;
    issuesApi.inspectExecutionReset = async () => {
      const result = structuredClone(inspection);
      if (state === "unknown") {
        result.holds[0].outcomeClassification = "unknown";
        result.holds[0].unknownActionIds = Array.from({ length: 12 }, (_, i) => `original-action-${i + 1}`);
        result.holds[0].actionCount = 12;
      }
      return result;
    };
    issuesApi.resetExecution = async () => {
      if (state === "stale") throw new ApiError("execution_reset_admission_rejected", 409, {});
      if (state === "uncertain") throw new Error("Synthetic lost response");
      return { resetId: "00000000-0000-4000-8000-000000000004", issueId,
        successorRunId: "00000000-0000-4000-8000-000000000005", previousRunId: inspection.holds[0].holdingRunId! };
    };
    return () => { issuesApi.inspectExecutionReset = originalInspect; issuesApi.resetExecution = originalReset; };
  }, [state]);
  return <ExecutionResetProvider value={{ issueId, agentId: "synthetic-agent", allowed: true, pauseReason: null, onQueued: () => {} }}><ExecutionResetEntry /></ExecutionResetProvider>;
}
const meta: Meta<typeof Fixture> = { title: "Tasks/Execution reset", component: Fixture, parameters: { layout: "fullscreen" } };
export default meta;
type Story = StoryObj<typeof Fixture>;
export const Ready: Story = { args: { state: "ready" } };
export const Unknown: Story = { args: { state: "unknown" } };
export const Queued: Story = { args: { state: "queued" } };
export const Stale: Story = { args: { state: "stale" } };
export const Uncertain: Story = { args: { state: "uncertain" } };
