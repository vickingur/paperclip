# Pause completion and historical stop proof

Pause and termination close admission before they wait for execution cleanup.
A cancelled row does not prove that its provider or tools have stopped.

The stop check reports the first blocking run and a fixed reason. Environment
cleanup also reports the lease ID. Live processes or groups, uncertain process
identity, future controller leases, remote termination receipts, and owned
finalizations retain their existing checks. Missing historical adapter identity
is unknown; current agent configuration is never used as proof.

A historical legacy conversation run can pass the missing-PID check only when
all of these records agree:

- Its result explicitly records `executionRecovery.providerStopped=true` and
  `actionOutcomes=settled`.
- Its executor recorded `executionStage=settled`, a controller boot identity,
  start and finish times, and an integer adapter exit code.
- Immutable dispatch or invocation evidence identifies a conversation adapter.
- The matching server completion event records cancellation and the same exit
  code after the finish time. A later dispatch or process-start event invalidates
  that completion.
- No controller lease remains and no incomplete tool inventory or pending tools
  contradict the result. All other process, lease, and finalization checks pass.

This path does not change the run, manufacture a cancellation acknowledgement,
replay tools, or resolve task recovery actions. Historical rows without this
proof remain blocked. Existing incident summaries that only show settled rows,
missing PIDs, and absent leases do not establish this proof. Operator recovery
for those rows still needs its separate evidence and approval.

## API behavior

Agent responses expose `lifecycleResumePending`, `lifecycleStopBlocker`, and
`lifecycleRetryAt`. The internal operation, worker owner, and responsible user
remain private. A resume during `pausing` clears the appropriate user holds and
persists intent, while returning the current blocker. Remaining budget and
company holds still prevent resume. After stop proof passes, the existing
worker completes pause and then resumes automatically when no holds remain.

Blocker diagnostics are replaced only when they change, under the current
worker version and owner fence. Pending stop checks use exponential delays of
2, 4, 8, 16, 32, then 60 seconds. They continue at most once per minute until
proof changes or an explicit lifecycle retry clears the delay. Normal plugin
polling retains its existing cadence.

## Local verification

Install with `pnpm install --frozen-lockfile`. Build the plugin SDK with
`pnpm --filter @paperclipai/plugin-sdk build` before the server suite. Run:

```sh
pnpm exec vitest run server/src/modules/agent-lifecycle/__tests__/lifecycle.test.ts
node scripts/check-agent-lifecycle-boundaries.mjs
```

If the shell has empty provider base URL overrides, remove those overrides for
the test process. Tests use a temporary PostgreSQL database and synthetic runs.
No provider request or production lifecycle change is required.

## Release and rollback evidence

The fork target is `custom`. The `Fork image` workflow in
`.github/workflows/fork-image.yml` builds images tagged with the source SHA at
`ghcr.io/vickingur/paperclip`. That workflow proves image publication, not runtime
deployment. Final acceptance needs the fork image workflow result, the deployed
image/source SHA, `/api/health` commit and healthy/readiness fields, and runtime
health evidence from the deployment owner. A newer deployed SHA needs Git
ancestry proof that it contains the reviewed merge. Video-pipeline CD status
cannot establish Paperclip deployment.

Revert the implementation commit through the reviewed fork PR workflow. There
is no schema migration. The added JSON keys are optional and can remain stored
when old code runs; old code ignores them. Rollback restores the former strict
historical check and two-second pending cadence. It can restore pause blocking
for runs accepted by this proof path, so retain the incident evidence.
