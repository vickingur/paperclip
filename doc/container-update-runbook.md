# Paperclip container update checks

Use the normal approved image update and container recreation procedure. Build
from the fork Dockerfile's `production` target (or its `cloud` descendant).
The image installs Chromium system libraries with Playwright **1.58.2** during
build. Do not repair a recreated container with a manual apt install: that repair
is lost on the next recreation.

Keep the existing app-home volume mounted at `/paperclip`. Its
`/paperclip/tooling/playwright-1.58.2` installation and browser cache must already
exist and be readable by `node`. This image change installs system libraries;
it does not provision the persistent tooling or browser binaries.

After every approved image update, run this one-line smoke test from the host
with the existing container name substituted for `CONTAINER`:

```sh
podman exec --user node CONTAINER node -e 'process.env.PLAYWRIGHT_BROWSERS_PATH = "/paperclip/tooling/playwright-1.58.2/browsers"; const { chromium } = require("/paperclip/tooling/playwright-1.58.2/node_modules/playwright"); (async () => { const b = await chromium.launch({ headless: true }); try { const p = await b.newPage(); await p.setContent("<title>chromium-smoke</title>"); if (await p.title() !== "chromium-smoke") throw new Error("Unexpected page title"); console.log("chromium-smoke: ok uid=" + process.getuid()); } finally { await b.close(); } })().catch(e => { console.error(e); process.exitCode = 1; });'
```

Use `docker exec` instead of `podman exec` when Docker owns the container.
The command uses synthetic in-memory HTML and makes no page network request.
Require exit code 0 and `chromium-smoke: ok` with a nonzero UID. Run it after
recreation, before any manual dependency install. Record the image/source SHA,
checked-at UTC, recreation evidence and output on the update task. A launch in
the old repaired container does not prove image persistence.

If the command fails, retain the error and use the normal approved rollback
procedure. Do not change runner, ingress or permissions to make this check pass.
