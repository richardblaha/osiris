# osiris-workspace

The host-side controller for Osiris IDE — `extensionKind: ["ui"]`, so it runs in
the local extension host (which has the `vscode` API and a real `node_modules`)
even when the window itself is a container remote.

| Piece | What it does |
| ----- | ------------ |
| **Osiris Start** | On an empty local window: reopens the last project (`osiris.startup.restoreLast`) or shows a webview with recent projects + **New Project…** / **Open Folder…**. `osiris.showStart` opens it any time. |
| **Model wizard** | The Start page also carries a form mapping each task class (`chat`, `codegen`, `review`, …) to a `<provider>/<model>` spec, saved to `osiris.models.*` (User or Workspace). API keys go to the OS keychain, never settings. Anything unset falls back to `osiris.models.defaultProvider` (`ollama/qwen3:4b`). A status-bar item + a one-shot startup notice nudge while incomplete; `osiris.configureModels` opens it. `taskModelEnv` injects `OSIRIS_MODEL_*` into the DevContainer so the headless crew (`crew.json` `taskModels`) picks them up; `osiris-ai` reads `osiris.models.chat` directly. |
| **`osiris.desktop.ensureDevContainer`** | `devcontainer up` via a thin CLI wrapper (`devcontainer-cli.ts`) — writes the Osiris fallback config, tags the container, injects agent API keys as `--remote-env`, starts the in-container server. Records the project in the recent list. |
| **Remote authority resolver** | Resolves `vscode-remote://osiris-devcontainer+<hash>/…` by finding the container via its `com.osiris.devcontainer.hash` label, waking it, (re)starting its server, and reading the port label. If the container is gone, rebuilds it from the recent-projects entry. |
| **Local-window guard** | When `osiris.devcontainer.enforce` is on and a folder is open outside an Osiris remote, offers **Reopen in DevContainer** / **Close Folder**. |
| **`Set Agent API Key…`** | Stores a key in the OS keychain (`context.secrets`); `collectAgentSecrets` reads `osiris.agent.secretEnvKeys` from there + the host env at container-create time. |
| **`Handover to Server` / `Fetch to Local`** | Drives the `@osiris/protocol` `HandoverClient`; Docker-heavy freeze/thaw is delegated to `osiris.desktop.performHandover` / `…performFetch`. |
| **Status bar** | Session location (`local` / `in transit` / `server`). |

### Modules

Pure + unit-tested: `authority.ts`, `resolver.ts`, `docker-cli.ts` (tiny `docker`
CLI wrapper — no `dockerode` in the bundle), `devcontainer-cli.ts`,
`server-config.ts`, `recent-projects.ts`, `start-view-html.ts`, `model-config.ts`.
`extension.ts` and `start-view.ts` are the VS Code layer.

> The resolver uses VS Code's **proposed** `resolvers` API — feature-detected at
> runtime and typed via `src/vscode-proposed.d.ts`. In a stock VS Code build the
> resolver simply doesn't register.

esbuild-bundled to CJS `dist/extension.js`; `vscode` external. Bundles
`@osiris/container-sync/devcontainer-template` (the fallback config) + zod (~745kb).
