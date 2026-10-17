/** Short fixed window for automatic fan-out. Human messages and saved decisions
 * keep their immediate path. The existing queued-run sweep supplies dispatch. */
export function wakeBatchDelayMs(input: {
  reason: string | null; actorType: string | null; interactionId: unknown; manual: boolean;
}): number {
  if (input.manual || input.actorType === "user" || input.interactionId) return 0;
  return input.actorType && ["issue_commented", "issue_children_completed"].includes(input.reason ?? "") ? 5000 : 0;
}

export function wakeBatchIsWaiting(context: Record<string, unknown> | null, now: Date): boolean {
  const deadline = context?.wakeBatchNotBefore;
  return typeof deadline === "string" && Date.parse(deadline) > now.getTime();
}
