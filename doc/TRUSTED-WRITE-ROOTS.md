# Trusted write roots for Codex ACP runs

A fork patch that lets one exact directory outside a run's workspace become
writable in the Codex ACP turn sandbox, for explicitly listed issues only.
Design: VIK-2207 proposal rev `f496d229-e9ae-4a56-bc32-f43cfa85a87c`, CTO
decision D1 (VIK-2208, confirmed on VIK-2209).

With `PAPERCLIP_TRUSTED_WRITE_ROOTS` unset the code is a no-op: every Codex
launch carries `PAPERCLIP_CODEX_ACP_TRUSTED_WRITE_ROOTS=[]`, the session
fingerprint is byte-identical to before, and no policy changes. Installing a
rule is a board access decision; merging this code is not.

## Rule source

`PAPERCLIP_TRUSTED_WRITE_ROOTS` in the **server** environment, a JSON array:

```json
[{"path":"/paperclip/worktrees/VIK-1691-cache",
  "companyId":"<company uuid>",
  "projectId":"<project uuid>",
  "issueIds":["<issue uuid>"],
  "workModes":["standard"],
  "agentIds":["<agent uuid>"],
  "adapterTypes":["codex_local"]}]
```

- All fields are required; arrays are non-empty; no other field is accepted.
  `workModes` may only be `["standard"]`. There is no project-wide grant.
- An absent value grants nothing. A malformed value grants nothing and logs
  `PAPERCLIP_TRUSTED_WRITE_ROOTS rejected; …` once per process.
- The rules hash is the first 12 hex chars of sha256 over the canonical JSON
  (keys sorted) of the parsed array.
- Adapter config env can never set `PAPERCLIP_TRUSTED_WRITE_ROOTS` or
  `PAPERCLIP_CODEX_ACP_TRUSTED_WRITE_ROOTS`: `isForbiddenConfigEnvKey` makes
  every adapter skip both keys at launch. Agent save validation is unchanged,
  so a saved config can still contain them; they have no effect.

Under D1 the only valid rule is the single VIK-2195 / Platform Engineer /
`codex_local` / standard grant at the canonical cache path. A second rule or
issue needs D2 first.

## What admits a run

The server resolves admissions when it builds `context.paperclipWorkspace`
(`server/src/services/heartbeat/trusted-write-roots.ts`), from DB values only:
the company-scoped issue record and the realized execution workspace. A run is
admitted only when the issue is not a chat, its company is the agent's, its
project equals the workspace project and the rule project, its `workMode` is
`standard`, and the issue, agent and adapter type are all listed. Wake
payloads and context values are overwritten, never read.

The engine (`packages/adapter-utils/src/acpx-engine/trusted-write-roots.ts`)
then validates each admitted path for a **local** Codex run (remote targets get
none): absolute and canonical; the root and every ancestor are real
directories, not symlinks, owned by root or the server uid, not group/world
writable; the root is not inside, and does not contain, any of the run's
writable roots (cwd, `/tmp`, temp dirs, agent home, scratch, referenced
projects, `CODEX_CONFIG` writable roots); no nesting between roots; no
`.git`, `.codex` or `.agents` entry (only a confirmed `ENOENT` counts as
absent; `EACCES`, `EIO` or any other lookup error drops the root); not `/`, `/paperclip` or
`/paperclip/worktrees`. It records `{dev, ino}`, re-checks right before the
borrow/spawn decision and again before a prompt on a reused warm runtime, and
codex-acp re-checks before every turn. Any failure drops that root.

`{path, dev, ino}` of the granted roots is part of the session fingerprint, so
a grant change never reuses a warm runtime or resumes a saved session.

## Evidence lines

| Where | Line |
| --- | --- |
| run log (engine) | `[paperclip] Codex trusted write roots: <[{path,dev,ino}]> admission=<[{issueId,ruleIndex}]> rules=sha256:<12> rejected=<json>` |
| run log (engine) | `[paperclip] warm handle <borrowed\|miss\|discarded> key=sha256:<12 of sessionKey> acpSessionId=<id>` |
| run log (engine) | `[paperclip] trusted write root dropped at launch: <path> (<reason>)` / `… before prompt: …` |
| child stderr log (codex-acp) | `[paperclip] turn sandboxPolicy sha256:<12> type=<t> writableRoots=<json> networkAccess=<b>` |
| child stderr log (codex-acp) | `[paperclip] trusted write root dropped: <path> (<reason>)` |
| run result | `resultJson.trustedWriteRoots = {roots, admission, rulesHash, rejected}` (only when something was admitted or rejected) |

When the engine captures child stderr, the log is `<stateDir>/run-stderr/<runId>.log`.

## Source checks (no grant needed)

```sh
pnpm vitest run server/src/services/heartbeat/trusted-write-roots.test.ts \
  server/src/__tests__/heartbeat-trusted-write-roots.test.ts \
  packages/adapter-utils/src/acpx-engine/trusted-write-roots.test.ts \
  packages/adapter-utils/src/acpx-engine/trusted-write-roots-session.test.ts \
  packages/adapter-utils/src/acpx-engine/session-reuse-store.test.ts \
  packages/adapter-utils/src/acpx-engine/execute-identity.test.ts
node --test scripts/codex-acp-trusted-write-roots.test.mjs scripts/codex-acp-network-policy.test.mjs
node --test scripts/codex-trusted-write-root-sandbox.test.mjs   # skips with a reason where bwrap cannot start
```

The sandbox script proves the Codex 0.160.0 bwrap layout on a disposable temp
fixture only. It is not live qualification.

## Live qualification (§4.6) — operator procedure

Every step below needs its own authorization: board approval of the host
steps, a fresh healthy DB backup and full app-home backup before any server
env change, and a CTO/Sysadmin-created synthetic qualification issue. The
synthetic rule names only that issue and cannot widen the production
allowlist. Do not stop or drain running processes without an explicit
operator decision. Do not copy, reset or chmod the canonical cache.

Fixtures (created by the operator, outside cwd, `/tmp`, `$TMPDIR` and every
agent home, same ancestor layout as the cache):
`/paperclip/worktrees/vik-2207-fx-root`, `/paperclip/worktrees/vik-2207-fx-sibling`,
and the internal symlink `vik-2207-fx-root/esc -> ../vik-2207-fx-sibling`.

For **every** run record: tested SHA and deployed fork-image SHA, run ID, ACP
session ID, UTC time, terminal status, the launch-roots line with admission and
rules hash, the `turn sandboxPolicy` line, each command's exit status, and the
file's presence or absence afterwards. Also show no extra trust or skill root:
`session/new` has no `additionalDirectories` or `_meta.additionalRoots`, the
Codex config has no `projects.<root>` trust entry, the session skill roots
equal baseline, and the turn policy differs from baseline only in
`writableRoots`.

| # | Setup | Action (inside the run) | Pass |
| --- | --- | --- | --- |
| 1 | fixture rule deployed; fixture issue in `standard` | `touch /paperclip/worktrees/vik-2207-fx-root/ok` | exit 0; file present; launch line lists the root with the recorded `dev`/`ino` |
| 2 | same run | `touch …/vik-2207-fx-sibling/x`; `touch …/vik-2207-fx-root/../vik-2207-fx-sibling/y`; `touch …/vik-2207-fx-root/esc/z` | each non-zero (EROFS); `x`, `y`, `z` absent |
| 3 | **warm, no restart.** Row 1's run ends with an idle granted handle in the host store; operator sets the same issue to `planning` and wakes it | `touch …/vik-2207-fx-root/plan` | non-zero; absent; prior handle not borrowed |
| 4 | unrelated `standard` issue, same agent and project | `touch …/vik-2207-fx-root/other` | non-zero; absent; launch line `[]` |
| 5 | the row 4 unrelated issue; the agent's adapter config env sets `PAPERCLIP_CODEX_ACP_TRUSTED_WRITE_ROOTS` to the fx-root `{path,dev,ino}` | `touch …/vik-2207-fx-root/inj` | injected value ignored (launch line `[]`); non-zero; absent. Remove the config key afterwards |
| 6 | **persisted, after restart.** Issue back to `standard`; a fresh granted run whose `sessionParams` are kept; operator removes the rule and restarts the server; wake the issue | `touch …/vik-2207-fx-root/after` | non-zero; absent; saved session not resumed |
| 7 | malformed rule env deployed | `touch …/vik-2207-fx-root/bad` | non-zero; absent; rejection warning logged |

Order: rows 1–5 with the fixture rule, row 6 removes it, row 7 deploys the
malformed value. Afterwards restore the pre-qualification env.

Row 3 evidence, all in one server process (server pid unchanged since row 1):
the prior run ID, ACP session ID, `sessionKey` hash and codex-acp child pid,
and a host-store line showing the entry idle; for the new run, its run ID and
ACP session ID (both different), its `sessionKey` hash (different), the
`warm handle miss` line for the new key and the `warm handle discarded` line
for the prior entry; the prior pid has exited and is not the new child; launch
roots `[]`; the `turn sandboxPolicy` line without the root. **If no idle
granted handle survives to the wake, row 3 is not passed**: record it as a
limitation and keep the gate open. A cold run is never warm proof. Note: the
current host lane closes every runtime after its turn (Amendment B credential
gate), so no idle warm handle is expected to exist; row 3 is then recorded as
not exercisable, not as passed.

Row 6 evidence: the granted run's run ID, saved `acpSessionId` and
`configFingerprint`; the restart (server pid changes) and the process check
that no granted child survived; for the new run, its run ID, a different ACP
session ID, `warm handle miss`, no `resumeSessionId`/`session/load` for the
saved ID, launch roots `[]`, the `turn sandboxPolicy` line, terminal status and
file absence.

Only after rows 1–7 pass does the board deploy the real rule and CTO accept
the healthy deployment; then Platform runs the original
`tools/fq.py … --run VIK-2195 …` and records exit status, canonical realpath,
lock inode and preserved bans and holds.

## Revocation and rollback

- Removing a rule takes effect at the next dispatch: the fingerprint changes,
  so no resume or borrow, and idle warm runtimes of the task are discarded. A
  codex-acp process that is already running keeps its spawn env until it
  exits.
- Grant rollback without a code change: (1) remove the rule; (2) list the
  admitted live runs (heartbeat runs of each `issueIds` entry that are
  `running` or `queued`) and their process identities; (3) if immediate
  revocation is needed, the operator decides to stop or drain exactly those
  runs; (4) restart the server and confirm no granted child remains; (5) the
  next launch line shows `[]`. The cache itself is untouched.
- Code rollback: revert the single PR. With the env unset the code is inert, so
  reverting changes no behaviour of runs without a rule.

## Known limits

- Same-uid processes outside the run's namespace can still swap a path between
  the per-turn check and a later command's bwrap start in the same turn (the
  §3.7 window). D1 accepts this for the VIK-2195 grant only; D2 (protected
  parents through the deploy boundary) is required before any second grant.
- Codex mounts read-only `.git`/`.agents`/`.codex` targets inside each writable
  root while a command runs. If a validation runs at that moment, the root is
  rejected (fail closed, no grant for that run).
