# Changelog

All notable changes to Osiris IDE are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project follows [Semantic Versioning](https://semver.org/).

Per-extension changes are tracked in `extensions/*/CHANGELOG.md`.

## [Unreleased]

### Added

- **Desktop** — `linux-x64` now also ships an **AppImage** and a classic
  confinement **snap**, both wrapping the same branded VSCodium tree as the
  `.tar.gz`. New `scripts/pack-appimage.mjs` (auto-downloads `appimagetool`) and
  `scripts/pack-snap.mjs` (`mksquashfs`, no snapcraft/LXD); `scripts/pack-linux.mjs`
  holds the unit-tested `.desktop` / `AppRun` / `snap.yaml` text. `package.mjs`
  builds both best-effort (warns + skips if the tooling is missing). `release.yml`
  attaches `Osiris-linux-x64-*.AppImage` and `Osiris-linux-x64-*.snap`.
- The AppImage `AppRun` detects a locked-down user-namespace host
  (`kernel.unprivileged_userns_clone=0` or AppArmor's
  `apparmor_restrict_unprivileged_userns=1`) and falls back to `--no-sandbox`
  instead of aborting with `FATAL:setuid_sandbox_host.cc` — override with
  `OSIRIS_SANDBOX=1` / `OSIRIS_SANDBOX=0`.

## [0.1.0-alpha.6] - 2026-09-03

First release with a **desktop** artifact, and the first cut end-to-end by the
unified `release.yml` (web + server + extensions + desktop).

### Added

- **Desktop** (`apps/osiris-desktop`) — rebuilt as a **rebrand of the VSCodium
  prebuilt** instead of a from-source build (VSCodium's own 1.94.2 recipe pins a
  retired `ubuntu-20.04` runner). `fetch-prebuilt.mjs` downloads + `sha256`-verifies
  the pinned release archive per platform; `apply-branding.mjs` overlays the Osiris
  `product.json` (keeping upstream `builtInExtensions` / `checksums`), swaps icons,
  renames `codium` → `osiris` and patches the launcher scripts; `package.mjs`
  repacks to `Osiris-<os>-<arch>-<release>.{tar.gz,zip}`. Portable, unsigned.
- `build-desktop.yml` rebuilt: one `ubuntu-latest` job, matrix over
  `linux-x64 / darwin-x64 / darwin-arm64 / win32-x64`. `release.yml` attaches the
  archives best-effort (a failed desktop leg never blocks the release).

### Removed

- `apps/osiris-desktop`: the from-source scaffold (`clone-upstream.mjs`,
  `build.mjs`, `electron-builder.yml`, placeholder `patches/`).

## [0.1.0-alpha.5] - 2026-09-03

First green end-to-end release: **web + server + extensions**. Desktop installers
are not included yet — the `apps/osiris-desktop` shell build is being reworked
onto VSCodium's own pipeline (it never assembled a real checkout).

The web runtime (`osiris-web-server-linux-x64.tar.gz`) is the branded
openvscode-server REH build with a bundled Node; unpack and run `bin/osiris-server`.

### Fixed

- **branding config-folder sweep** matched the `vscode` _identifier_
  (`globalThis.vscode`, `Schemas.vscode`, `manifest.engines.vscode`) — 20 false
  positives that hard-failed `prepare:shell`. The detector now only matches a
  `.vscode` _path literal_; the sweep covers `src/vs/{workbench,platform,code,server}`.
- **bundled Fira Code** is embedded into the workbench stylesheet as a `data:`
  URI — the web build runs that CSS through esbuild, which has no `.woff2` loader
  and errored on the external font `url()`.
- **desktop** pinned a non-existent VSCodium tag (`1.94.2.24285` → `.24286`).

### CI / Release

- `release.yml` is the single tag-driven entrypoint: packs the extensions, calls
  `build-web.yml` as a reusable workflow, stages the `vscode-reh-web-*` bundle as
  `osiris-web-server.tar.gz`, and attaches it + every `.vsix` to a draft GitHub
  Release. Tags with a hyphen are marked pre-release.
- `build-desktop.yml` is not wired into the release (desktop deferred);
  `build-web.yml` gains `workflow_call`. Both keep `workflow_dispatch`.
- alpha.2–alpha.4 were internal iterations getting the shell builds green for the
  first time; alpha.5 is the first published release.

## [0.1.0-alpha.1] - 2026-09-03

First tagged pre-release of the 0.1.0 line. Cuts installers, the web server
bundle and the packed extensions from a single `v*` tag.

### Desktop (`apps/osiris-desktop`)

- Electron distribution assembled from the Code - OSS / VSCodium core with
  Osiris branding (product name, rendered icon set, `Osiris Dark` / `Osiris Light`).
- `prepare:shell` / `build:shell` / `package` pipeline producing Linux, macOS and
  Windows artifacts via `build-desktop.yml`.

### Web (`apps/osiris-web`)

- Browser-served runtime following the OpenVSCode Server pattern.
- CLI wrapper entrypoint (`server/index.mjs`) and a container image
  (`apps/osiris-web/Dockerfile`); built and smoke-tested by `build-web.yml`.

### Server (`apps/osiris-server` + `apps/osiris-console`)

- Crew/backlog/memory HTTP API (`/api/v1/*`) with a `/healthz` probe.
- Persisted crew runs and a "Recent runs" list in the console SPA.
- Console task detail / history and backlog sync.
- Container image (`apps/osiris-server/Dockerfile`) + compose stack with ChromaDB;
  image build and API smoke covered by `osiris-server.yml`.

### Platform packages

- `@osiris/crew` — multi-agent orchestrator with task-class model routing and an
  MCP tool bridge.
- `@osiris/mcp` — Model Context Protocol client shared by the crew and `osiris-ai`.
- `@osiris/memory` — ChromaDB-backed knowledge base with `osiris memory watch`.
- `@osiris/backlog` — Git orphan-branch backlog with push/pull and `osiris backlog lint`.
- `@osiris/lm-proxy` — editor LM API bridged to the crew.
- `@osiris/branding` — icon rendering and the shell theme overlay.
- `osiris` CLI — `init`, `doctor`, `crew run`, `backlog`, `memory` commands.

### Extensions

- `osiris-ai` — provider-agnostic agent orchestrator, MCP client, React agent panel.
- `osiris-dexpi` — DEXPI/Proteus parser, rule-based validator, P&ID SVG preview.
- `osiris-step` — ISO 10303-21 parser with a three.js 3D preview.
- `osiris-workspace` — DevContainer remote authority, session handover, Osiris Start
  page with model onboarding, and the Osiris sidebar panel (Kanban backlog + crew runner).

### CI / Release

- `release.yml` cuts a GitHub Release from a `v*` tag; `build-desktop.yml` and
  `build-web.yml` attach the installers and the web bundle for the same tag.

[0.1.0-alpha.6]: https://github.com/richardblaha/osiris/releases/tag/v0.1.0-alpha.6
[0.1.0-alpha.5]: https://github.com/richardblaha/osiris/releases/tag/v0.1.0-alpha.5
[0.1.0-alpha.1]: https://github.com/richardblaha/osiris/releases/tag/v0.1.0-alpha.1
