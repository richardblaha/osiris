# Changelog

All notable changes to Osiris IDE are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project follows [Semantic Versioning](https://semver.org/).

Per-extension changes are tracked in `extensions/*/CHANGELOG.md`.

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

[0.1.0-alpha.1]: https://github.com/richardblaha/osiris/releases/tag/v0.1.0-alpha.1
