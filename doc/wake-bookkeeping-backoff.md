# Wake bookkeeping backoff

Repeated `issue_unblock_requested` requests use a five-minute backoff after a
successful issue run. The issue lock serializes admission. The run history is
the durable clock, so restarts and a new blocked transition do not reset it.
Agent status comments do not reset this backoff. New external issue input and
explicit operator resumes retain the normal admission path. Actual dependency,
interaction and approval resolution events keep their existing wake reasons.
Failed runs retain recovery admission. Existing stop, pause, budget and ownership
checks remain in force.

Five minutes bounds the delay for an invalid parked issue while eliminating
45-second retry storms. Expiry permits another attempt; it does not enqueue a
new timer. The existing sweeper supplies any later request.

The existing issue queue combines pending follow-ups for the same company,
issue and agent. A running turn has already taken its input snapshot. Child
completion therefore joins the durable follow-up queue instead of being written
only to the running turn. One necessary continuation consumes the combined
input. Queued contexts retain all distinct wake reasons and comment IDs. Saved
interaction decisions retain separate receipts. Automatic comment/child fan-out also has a fixed five-second queue window.
Later arrivals do not extend it. The existing queued-run sweep dispatches after
the deadline, so scheduler cadence can add latency. Human input releases a queued
batch immediately. This change adds no timer or fixed delay to human messages.

A transient run does not resolve a pending disposition repair action. Its
actual final disposition must supply a durable path first.

An automatic recovery-action restoration does not grant a fresh disposition
repair budget for the same source fingerprint. The highest spent attempt in
active or automatically restored actions remains authoritative. The existing
bounded repair schedule and escalation apply. A distinct source fingerprint and
explicit owner hand-back keep their existing semantics.

The existing recovery report includes `wakeWaste.hourly` and `wakeWaste.daily`.
Hourly buckets use UTC dispatch start times and count distinct run IDs with
system-origin receipts. Requested, skipped and coalesced receipts are not actual
runs. At five system wakes per issue/hour, `alertKey` identifies the breached
bucket. The same key persists at six and across report retries. Reporting does
not write a comment or wake an agent. A report consumer must deduplicate on this
key when delivering alerts.

Daily no-op counts require explicit `resultJson.noOpClassification` evidence:
`restated_status` means no-op and `productive` means known work. Unclassified
runs are unknown. The report does not infer successful deployment, avoided runs,
or no-op outcomes from fewer requests. Historical incident counts and the
production observation window require separate provider evidence.
