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

