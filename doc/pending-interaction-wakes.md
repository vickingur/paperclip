# Pending interaction wakes

A pending agent-addressed card wakes its current addressee. The task assignee can
be a different agent. Admission, deferred promotion and final provider dispatch
read the company-scoped card and apply its current resolver audience. Resolved,
withdrawn, expired, human-only and inaccessible cards do not grant attention.

Repeated events for one card and recipient share a delivery receipt. A queued
attention run is not an obsolete assignment merely because its agent differs
from the task owner. It still waits behind the active task execution.

If automatic ownership supersession cancels delivery, issue release retains its
receipt in the existing deferred queue. Promotion rechecks the pending card and
uses the current recipient. Recovery is limited to one follow-up for an unchanged recipient;
a later recipient change can establish a new delivery. A repeated cancellation
for the same recipient cannot produce a retry loop. Existing queue recovery can
resume a retained receipt after restart. There is no historical-card scan and no
new timer.

The retained receipt has first priority at release. If its recipient cannot run
or the receipt is cancelled, ordinary deferred work can proceed in the same
drain. An acknowledged stop still limits this release to the retained receipt;
it cannot promote unrelated work.

Explicit operator or agent stops, budget gates, subtree pauses, active execution,
provider-stop proof and unresolved action outcomes retain their existing gates.
The follow-up addresses the card; it does not approve work, resolve the card or
change the task assignee.

Focused synthetic checks:

```sh
pnpm exec vitest run server/src/services/pending-interaction-wake.test.ts \
  server/src/__tests__/heartbeat-stale-queue-invalidation.test.ts \
  server/src/modules/run-dispatch/adapters/postgres.test.ts \
  server/src/modules/wake-queue/adapters/postgres.test.ts \
  server/src/services/heartbeat/queue.test.ts \
  server/src/services/heartbeat/run-control.test.ts
```
