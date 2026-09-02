# osiris-workspace

DevContainer enforcement and session mobility for Osiris IDE.

| Piece | What it does |
| ----- | ------------ |
| **Remote authority resolver** | Resolves `vscode-remote://osiris-devcontainer+<hash>/…` to a live VS Code server by finding the container via its `com.osiris.devcontainer.hash` label, waking it if paused, and reading the port label. |
| **Local-window guard** | When `osiris.devcontainer.enforce` is on and the window is *not* an Osiris remote, offers **Reopen in DevContainer** / **Close Folder**. |
| **`Osiris: Open Folder in DevContainer…`** | Folder picker → reopen through the `osiris-devcontainer` authority. |
| **`Handover to Server` / `Fetch to Local`** | Drives the `@osiris/protocol` `HandoverClient` (`prepare` → freeze/upload → `commit`); the Docker-heavy freeze/thaw is delegated to the desktop via `osiris.desktop.*` commands. |
| **Status bar** | Shows the session location (`local` / `in transit` / `server`). |

### Modules

`authority.ts`, `resolver.ts`, `docker-cli.ts` (a tiny `docker` CLI wrapper — no
`dockerode` in the extension host) and `server-config.ts` are pure and unit-tested;
`extension.ts` is the thin VS Code layer.

> The resolver uses VS Code's **proposed** `resolvers` API — feature-detected at
> runtime and typed via `src/vscode-proposed.d.ts`. In a stock VS Code build the
> resolver simply doesn't register.

esbuild-bundled to CJS `dist/extension.js`; `vscode` external.
