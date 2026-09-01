<div align="center">

<img src="packages/branding/assets/osiris.svg" width="120" alt="Osiris IDE" />

# Osiris IDE

**A custom, open-source developer platform built from VS Code (Code - OSS / VSCodium core) — for desktop and the browser.**

[![CI](https://github.com/osiris-ide/osiris/actions/workflows/ci.yml/badge.svg)](https://github.com/osiris-ide/osiris/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-informational.svg)](LICENSE)

</div>

---

## What is this?

Osiris IDE is a **downstream distribution** of [Code - OSS](https://github.com/microsoft/vscode)
(assembled through the [VSCodium](https://github.com/VSCodium/vscodium) pipeline) with:

- **Osiris branding** — product name, icons, theme defaults (`Osiris Dark` / `Osiris Light`).
- **First-party extensions** shipped in the box:
  - `osiris-ai` — AI agent orchestration with **MCP (Model Context Protocol)** support and a custom agent panel.
  - `osiris-dexpi` — **DEXPI** (XML / P&ID) parser, SVG visualizer and schema validator.
  - `osiris-step` — **ISO 10303-21** (`.step` / `.stp`) parser with a 3D WebGL preview.
- Two delivery targets:
  - `apps/osiris-desktop` — Electron packages for Linux, macOS and Windows.
  - `apps/osiris-web` — a browser-served runtime following the OpenVSCode Server pattern.

> The upstream VS Code source is **never vendored** into this repo. The desktop/web
> builds clone a pinned upstream tag at build time and apply Osiris overlays + patches.

## Repository layout

```text
osiris/
├── apps/
│   ├── osiris-desktop/   # Electron wrapper, OS packaging, branding entrypoint
│   └── osiris-web/       # Web runtime / standalone server
├── packages/
│   ├── branding/         # Icons, themes, product.json overlay, asset metadata
│   ├── shell-theme/      # Theme provider + OS / host theme detection
│   └── shared-core/      # Shared utilities, types, telemetry & event bus
├── extensions/
│   ├── osiris-ai/        # AI agent orchestration + MCP + agent panel
│   ├── osiris-dexpi/     # DEXPI (P&ID) parser, visualizer, validator
│   └── osiris-step/      # ISO 10303-21 STEP parser + 3D preview
└── toolchain/
    ├── eslint-config/    # Shared flat ESLint config
    └── tsconfig/         # Shared TypeScript base configs
```

## Prerequisites

- **Node.js 22 LTS** (`nvm use` reads `.nvmrc`)
- **pnpm 9** (`corepack enable`)
- For desktop builds: the platform toolchain VS Code itself requires
  (`git`, Python 3, a C/C++ compiler, and on Linux the `libx11`/`libsecret` dev packages).

## Quickstart

```bash
corepack enable
pnpm install

pnpm build        # build every package + extension (Turborepo)
pnpm test         # vitest across packages + extension logic
pnpm lint         # eslint (flat config)
pnpm typecheck    # tsc -b across the workspace
```

### Working on an extension

```bash
pnpm --filter osiris-dexpi build
pnpm --filter osiris-dexpi test
pnpm --filter osiris-dexpi package     # produces osiris-dexpi-*.vsix
```

Press <kbd>F5</kbd> in VS Code with one of the committed launch profiles in
[`.vscode/launch.json`](.vscode/launch.json) to run an extension in an Extension
Development Host against the fixtures in each extension's `test/fixtures/`.

### Building the desktop app

```bash
pnpm --filter @osiris/desktop prepare    # clone pinned VSCodium tag + apply branding/patches
pnpm --filter @osiris/desktop build
pnpm --filter @osiris/desktop package    # electron-builder → apps/osiris-desktop/dist_electron
```

### Building / running the web runtime

```bash
pnpm --filter @osiris/web prepare
pnpm --filter @osiris/web build
node apps/osiris-web/server/index.mjs --port 3000
# or:
docker build -t osiris-web apps/osiris-web && docker run -p 3000:3000 osiris-web
```

## Build matrix

| Target                | Command                                 | CI workflow         | Output                            |
| --------------------- | --------------------------------------- | ------------------- | --------------------------------- |
| Packages / exts       | `pnpm build`                            | `ci.yml`            | `dist/`, `media/`, `*.vsix`       |
| Desktop (Lin/Mac/Win) | `pnpm --filter @osiris/desktop package` | `build-desktop.yml` | AppImage / deb / rpm / dmg / nsis |
| Web + Docker          | `pnpm --filter @osiris/web build`       | `build-web.yml`     | server bundle + container image   |
| Release               | tag `v*`                                | `release.yml`       | GitHub Release with all artifacts |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md).
Security reports: [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE). Osiris IDE is not affiliated with or endorsed by Microsoft.
"Visual Studio Code" and the VS Code logo are trademarks of Microsoft; Osiris
ships none of Microsoft's trademarked assets.
