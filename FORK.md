# vickingur/paperclip fork

Personal fork of [paperclipai/paperclip](https://github.com/paperclipai/paperclip). Fork-only patches; nothing is sent upstream.

## Branches

| Branch | Contents |
|---|---|
| `custom` (default) | upstream `master` + fork patches. Rebased daily; force-pushed. |
| `master` | Unused snapshot from fork creation. Not synced: pushing it would run upstream's workflows. |
| `feat/*`, `fix/*` | Fork patch work; merge into `custom` by PR. |

Local clone remotes: `origin` = this fork, `upstream` = paperclipai/paperclip. After a sync, update with `git fetch origin && git reset --hard origin/custom` on `custom`.

## Automation

| Workflow | Trigger | Does |
|---|---|---|
| `fork-sync.yml` | daily 05:17 UTC, manual | Rebases `custom` onto upstream `master` and pushes. On conflict, opens a `fork-sync-conflict` issue. Disables every non-`fork-*` workflow. Needs secret `FORK_SYNC_TOKEN`. |
| `fork-image.yml` | push to `custom`, manual | Builds `linux/amd64` and pushes `ghcr.io/vickingur/paperclip:{custom, <version>, sha-<sha>}`. |

Image version: `<upstream describe of merge base>+vik.<fork commit count>`, e.g. `v2026.1005.0-300-g0e37a385e+vik.3` (tag uses `-vik.3`).

`FORK_SYNC_TOKEN`: fine-grained PAT, repository `vickingur/paperclip`, permissions Contents and Workflows read/write.

## Fork patches

| Patch | Why |
|---|---|
| Fork CI (`fork-*.yml`, this file) | Sync and image build for the fork. |
| Agent save re-tests AI account only on binding or runtime-target change (`server/src/routes/agents.ts`) | Upstream compared jsonb bindings as strings, so every agent edit (title, reporting line, timeout) ran a live provider hello test and failed while the account needed sign-in. |
| Operator env pass-through (`packages/adapter-utils/src/acpx-engine/execute.ts`) | `PAPERCLIP_AGENT_PASSTHROUGH_ENV=NAME,NAME` names server variables every host agent inherits. Upstream passes agents a fixed allow-list, so a plugin or hook directory set on the container (usage-guard's `CLAUDE_CODE_PLUGIN_DIRS`, `UG_DIR`) never reached them. |
| Provider-home setup command (`server/src/services/ai-home-setup.ts`) | `PAPERCLIP_AI_HOME_SETUP_COMMAND` runs once a run's provider home is seeded, with `CODEX_HOME`/`CLAUDE_CONFIG_DIR` and `PAPERCLIP_AI_HARNESS` set. Codex trusts a hook by its `hooks.json` path, and each run gets a fresh home, so the hook must be written and trusted per run. A failure is logged; the run goes on. |

