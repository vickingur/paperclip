# Runtime GitHub credential request limit

The shared operation credential resolver admits at most 120 requests per company,
agent and run in a rolling 60-second window. Both the runtime HTTP route and the
native session broker return HTTP 429 when the budget is exhausted. The launcher
treats this as an unavailable credential response, without a transport retry.
The limit runs before identity/database and secret-store work. Existing run,
identity and trust checks still apply to every admitted request.

Counters are process-local and reset on server restart. Multiple server processes
each have their own budget. This is defense in depth for launcher recursion, not a
distributed admission mechanism. Idle counters are pruned on a subsequent request;
each counter retains at most 120 timestamps. No token or credential is stored.
Legitimate bursts above this limit must wait for the rolling window to expire.

At debug level, admitted requests record companyId, agentId and runId. Credentials,
provider responses, login names and request headers are excluded from that event.
The separate launcher re-entry guard prevents a PATH shim from creating unbounded
processes. The request cap does not terminate a CLI or change silent-run policy.
