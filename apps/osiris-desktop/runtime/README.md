# Osiris desktop runtime hook

`osiris-main.mjs` runs inside the Electron **main process**. Because the VSCodium
source is cloned at build time and never vendored, it is wired in by
`patches/0002-osiris-runtime-hook.patch` (applied by `scripts/apply-branding.mjs`).

## Injection point

VSCodium's main entry (`src/vs/code/electron-main/main.ts` → compiled
`out/main.js`) gets one added block right after `app` becomes ready:

```js
import(require('path').join(__dirname, '../../../../runtime/osiris-main.mjs'))
  .then((m) => m.activateOsirisRuntime({ app: require('electron').app }))
  .catch((err) => console.error('[osiris] runtime hook failed', err));
```

`0002-*.patch` carries a hunk against a recent tag; `apply-branding.mjs` applies
every `patches/*.patch` with `git apply --3way` and tolerates one that no longer
matches (warns + skips). Re-roll the hunk after an upstream bump.

## What it does

`activateOsirisRuntime({ app })` calls `bootstrapOsirisRuntime()` from
`@osiris/desktop-host`: starts `@richardblaha/telemetry` and the local stack
(`@osiris/orchestrator`: Ollama, OTLP collector, dashboard, sync worker), then
publishes `OTEL_EXPORTER_OTLP_ENDPOINT` / `OSIRIS_OLLAMA_URL` / `OSIRIS_LOCATION`
into the environment the extension host inherits. It disposes the stack on
`will-quit`.

`resolveDesktopConfig()` (pure, unit-tested) reads `OSIRIS_DASHBOARD`,
`OTEL_EXPORTER_OTLP_ENDPOINT`, `OSIRIS_DEVCONTAINER_PORT`, `OSIRIS_SERVER_URL`,
`OSIRIS_SERVER_TOKEN`, `OSIRIS_REGISTRY`.

## Not here

DevContainer enforcement, `devcontainer up`, agent-key injection and session
handover live in the **`osiris-workspace`** extension (`extensionKind: ["ui"]`),
which runs in the local extension host — it has the `vscode` API and a real
`node_modules`, neither of which this process has. The main process only owns the
dependency stack lifecycle.

## Packaging note

`@osiris/desktop-host` is a workspace dependency; `electron-builder` must resolve
the pnpm symlink (hoist it, or `pnpm deploy` the app) so
`node_modules/@osiris/desktop-host/dist` ships in the installer.
