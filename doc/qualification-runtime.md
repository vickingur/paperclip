# Fork qualification runtime

Prepared 2026-10-13 for VIK-795. This patch prepares tools and an author-run
qualification procedure. Independent review does not authorize deployment,
restart, migration, spending, host access or agent configuration changes.

## Tool image

The production Dockerfile installs build-essential and pkg-config before the
application copy, retaining the existing Python and bundled Node headers. It
copies only the installed Rust toolchains and rustup from rust-toolchain, then
creates Cargo/compiler/format proxies. It excludes cargo-chef, crate caches and
compiled targets. RUSTUP_HOME is immutable/root-owned; writable CARGO_HOME and
build outputs belong to each qualification checkout. The package-owned
rust-toolchain.toml remains the sole compiler version pin. Toolchain automatic
installation is disabled during checks; a new pin needs a newly built image.

The Node base is pinned to the multiarchitecture index digest
`sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66`,
resolved from Docker Hub library/node:24-trixie-slim on 2026-10-13. Review this
pin with the candidate; updates must move executable and headers together.
The build-time non-root smoke verifies C/C++/make/Python/pkg-config, exact Cargo
and rustc versions, and Node header version equality. It does not replace checks
under the actual remapped runtime UID/Framework architecture.

Operator owns the image build using the existing fork procedure. Record the
reviewed source commit and resulting image digest; do not build or deploy through
an agent host workaround. Coordinate with the corrected VIK-662 series (candidate
f72006b27ffc0cd0e49cd701176ca32db2b922f0 on b2e962b50fa985e38eebd40569cfa184373735a9).
This patch is an additional commit on that candidate. If already shipped, replay
onto the next reviewed fork base and repeat identity/scope checks. Aim for one
approved recreate. Never assume VIK-662's deployment approval covers this patch.

## Prepare and replay (author)

Use a new private writable clone with complete git metadata, no dependencies or
runtime .env files. Do not use the shared project checkout or symlink production
/app/node_modules. All dependency links and store paths must belong to the private
checkout/run. Obtain the exact base object and delivered format-patch attachment.
Record its SHA-256 before applying it; use git am, not a manually assembled diff.
The accompanying incremental git bundle preserves exact base/candidate objects
with b2e962b as its prerequisite. Fetch it into the private clone before replay
so the expected candidate object exists independently of the git-am result.

```sh
git clone --no-hardlinks /path/to/available/fork-git /tmp/qualification-private
cd /tmp/qualification-private
git bundle verify /path/to/qualification-runtime.bundle
git fetch /path/to/qualification-runtime.bundle vik-795-qualification-runtime:refs/qualification/candidate
git checkout --detach <recorded-base-sha>
sha256sum /path/to/delivered.patch
git -c user.name='Qualification replay' -c user.email='qualification@invalid' am /path/to/delivered.patch
git rev-parse HEAD
git rev-parse 'HEAD^{tree}'
git rev-parse '<recorded-candidate-sha>^{tree}'
git status --porcelain --untracked-files=all
git diff --name-status <recorded-base-sha> <recorded-candidate-sha>
git diff --name-status --diff-filter=D <recorded-base-sha> <recorded-candidate-sha>
```

Applied HEAD can differ due to committer metadata; the tree must equal the
recorded candidate tree. Attach replay output and the two scope listings.
Review every deletion; require zero unintended deletions and explicit reviewer
justification for intended deletions. Tree equality alone proves no scope claim.

## Isolation review before full commands

The wrapper strips inherited provider/API tokens, database URLs, production HOME,
config and caches. It sets private HOME, PAPERCLIP_HOME, TMPDIR, Cargo cache,
pnpm store and config/cache directories. Existing staging scripts require
packages/paperclip-runner/runner/target, so that ignored target directory stays
inside the private writable checkout. No production dependencies are reused.
It opts out of telemetry, bounds Rust jobs at two, pnpm workspace concurrency at
one and each Node heap at 4096 MiB. Top-level commands run serially.

This is environment isolation, not a filesystem or network sandbox. Before
passing --isolation-reviewed-tree, the author and reviewer must inspect the
exact candidate's full test path, install hooks and build scripts for hardcoded
live database paths, production secrets, external provider endpoints and metered
calls. Use synthetic fixtures and temporary state only. Never pass the flag to
bypass an unresolved dependency. If isolation cannot be established, stop and
route the exact dependency to Architect/Chief of Staff; do not run full commands
or claim qualification. Existing provider subscriptions are not test authority.
No test selection or skipped-suite substitution is allowed.

## Run inside the approved runtime (author, zero operator tests)

Run as the actual non-root agent UID on Framework, after the approved image is
available. Image digest is supplied from operator image evidence, not inferred
from a tag or an environment variable. Smoke can also run independently:

```sh
python3 scripts/qualify-runtime.py smoke
python3 scripts/qualify-runtime.py qualify \
  --base <recorded-base-sha> \
  --candidate <recorded-candidate-sha> \
  --image-digest sha256:<actual-running-image-digest> \
  --isolation-reviewed-tree <reviewed-candidate-tree> \
  --state /tmp/qualification-state-unique
```

State must be a new directory outside the checkout. It is retained after failure
for inspection. The wrapper records actual HEAD/tree, expected candidate/tree,
base, lockfile hashes, UID, architecture and compiler pin, then runs:

1. Non-root smoke and Node header equality.
2. NODE_ENV=development pnpm install --frozen-lockfile --prod=false, private store.
3. Compile broker peercred-native.c through its real build script, load the new
   addon and check the native export/error validation (no host socket required).
4. Runner release build with committed Cargo.lock, --locked.
5. pnpm typecheck (root preflight), pnpm -r typecheck, pnpm test:run, pnpm build.

Each command log and exit code is under state/evidence; failures stop the serial
run and preserve logs. Lockfile resolution failures remain failures. Correct
source/lockfiles only in a new reviewed candidate, then start a fresh replay and
run. Before/after git status and tracked changes plus ignored output listing
separate source changes from generated output. Any untracked output needs review;
it is conservatively a failed qualification until accounted for.

steps.jsonl records elapsed wall time, Linux child high-water RSS and sampled
aggregate RSS for each command's process group (100 ms intervals).
metadata.json records total elapsed time, disk growth of checkout plus state,
and child RSS high-water. Report the maximum sampled group RSS with child RSS;
sampling can miss short peaks and excludes processes that detach into a different
group. This is a measured estimate, not a cgroup memory limit or host-wide peak.

The author records authorized read-only /api/health latency/status and safe
health fields before, between steps and after the representative run, along with
instance responsiveness observations. Keep API credentials outside command
logs; never dump environment/config. For a long step, collect a bounded health
sample during that step from the existing control-plane terminal. Do not install
a timer heartbeat or new service. If responsiveness degrades, stop qualification,
record the measurement and route contention to Chief of Staff; do not widen
permissions or switch models. Upload logs/metadata/status/scope/replay evidence to
the author task; Sysadmin tracks acceptance on VIK-788. All required full commands
must pass; report even pre-existing failures without claiming acceptance.

## Review and deployment gates

Software Engineer 4 owns independent review. Author publishes patch SHA-256,
base/candidate/tree, scope/deletions and available pre-deployment evidence on
VIK-795. Sysadmin owns the actual-runtime acceptance record on VIK-788; author
executes all qualification commands once the approved runtime exists. Missing
image/build tools are evidence gaps, not successful qualification. Operator owns
image build and separately approved deployment; no operator test execution is
required by this runbook.

Before a separately approved replacement, operator verifies /api/health: latest
database dump younger than two hours and lastFailure null. Record current image
digest and unchanged launch/mount configuration privately. Identify the entire
host app-home source mapped to /paperclip. Under the approved maintenance window,
quiesce writers through the existing procedure, archive the whole app-home with
ACLs, xattrs and numeric owners, restrictive permissions and a unique filename;
verify inventory, checksum and free space. Keep secrets/archive on the host.
Retain the old image digest. Build the reviewed candidate and obtain separate
board approval for replacement/restart.

Rollback of this tool-only commit is recreation from the recorded prior image
and unchanged launch/mount configuration under board approval. Check the combined
candidate for schema changes first: VIK-662 includes application changes, so
image rollback alone must not be assumed sufficient. Never overwrite newer
writes with an old app-home/database. State restoration requires separate restore
approval and an operator recovery plan; migrations are outside this patch.
