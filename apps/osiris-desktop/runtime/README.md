# Osiris desktop runtime hook

`osiris-main.mjs` runs inside the Electron **main process**. Because the VSCodium
source is cloned at build time and never vendored, it is wired in by a patch
applied from `scripts/apply-branding.mjs` (step 3).

## Injection point

VSCodium's main entry (`src/main.ts` → compiled `out/main.js`, around the point
where `app` is ready and before the first window opens) gets one added block:

```js
// >>> Osiris runtime
import(require('path').join(__dirname, '../../../runtime/osiris-main.mjs'))
  .then((m) => m.activateOsirisRuntime({
    app,
    dialog: require('electron').dialog,
    ipcMain: require('electron').ipcMain,
    openWorkbench: (opts) => app.emit('open-url', {}, opts.folderUri),
  }))
  .catch((err) => console.error('[osiris] runtime hook failed', err));
// <<< Osiris runtime
```

Add that as `patches/0002-osiris-runtime-hook.patch` once the exact upstream line
for the pinned tag (`config/upstream.json`) is known; `apply-branding.mjs` already
applies every `patches/*.patch` and tolerates ones that don't match.

## What it does

1. `bootstrapOsirisRuntime()` — starts `@osiris/telemetry` and brings up the
   local stack (`@osiris/orchestrator`: Ollama, OTLP collector, dashboard, sync
   worker), then publishes `OTEL_EXPORTER_OTLP_ENDPOINT` / `OSIRIS_OLLAMA_URL`
   into the environment the extension host inherits.
2. `installDevContainerGuard()` — intercepts `open-file`, `second-instance`
   (`--folder-uri`), and the `osiris.openFolder` IPC, routing raw host paths
   through **Open in Osiris DevContainer**.
3. `createDesktopHandoverCommands()` — the `osiris.desktop.*` handlers the
   `osiris-workspace` extension calls for freeze/thaw.

`resolveDesktopConfig()` (pure, unit-tested) reads `OSIRIS_DASHBOARD`,
`OSIRIS_SERVER_URL`, `OSIRIS_SERVER_TOKEN`, `OSIRIS_REGISTRY`,
`OSIRIS_DEVCONTAINER_PORT`.

## Packaging note

`@osiris/desktop-host` is a workspace dependency; `electron-builder` must resolve
the pnpm symlink (hoist it, or run `pnpm deploy` for the app) so
`node_modules/@osiris/desktop-host/dist` ships in the installer.
