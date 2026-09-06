<div align="center">

# Osiris AI

**A CLI-driven AI agent platform — CLI, Kubernetes operator, API and a multi-agent crew engine.**

[![CI](https://github.com/richardblaha/osiris/actions/workflows/ci.yml/badge.svg)](https://github.com/richardblaha/osiris/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-informational.svg)](LICENSE)

</div>

---

## What is this?

Osiris is an AI agent distributed as a CLI tool (`osiris`) that runs locally but
delegates the real work — dev environments, sessions, layered memory — to a local
Kubernetes cluster (`kind`), managed by `osiris-kind-operator`. It ships with:

- The **`osiris` CLI** — multi-agent crew orchestration, a file-based Git backlog,
  a ChromaDB-backed knowledge base, and MCP server support.
- **`osiris-kind-operator`** — a Go/kubebuilder operator that reconciles
  `OsirisProject`/`OsirisSession` CRDs (scale-to-0 + PVC suspend/resume).
- **`osiris-api`** — a REST API (git hosting, sessions, crew/backlog/memory)
  behind the lightweight `osiris-console` SPA (Kanban board, crew runs, KB search).

This is the agent/platform half of Osiris. The IDE half — a custom VS Code
distribution (desktop + web) and its `osiris-ai`/`osiris-workspace` extensions —
lives in [`osiris-ide`](https://github.com/richardblaha/osiris-ide). Six packages
(`osiris-core`, `osiris-protocol`, `osiris-agent-core`, `osiris-mcp`, `osiris-config`,
`osiris-telemetry`) are used by both repos; they live here and are published to GitHub
Packages under the `@richardblaha` scope for `osiris-ide` to consume (see
`.github/workflows/publish-packages.yml`).

## Repository layout

```text
osiris-ai/
├── apps/
│   ├── osiris-api/           # REST API: git hosting, sessions, crew / backlog / memory
│   └── osiris-console/       # Lightweight SPA — Kanban board, crew runner, KB search
├── packages/
│   ├── osiris-core/          # Shared utilities, types, telemetry & event bus
│   ├── osiris-protocol/      # zod wire contracts (sessions, crew, backlog, memory)
│   ├── osiris-agent-core/    # Provider-agnostic single-agent loop + snapshot
│   ├── osiris-config/        # The .osiris/ layout resolver + bundled system template
│   ├── osiris-memory/        # Knowledge base: chunking + incremental ChromaDB index
│   ├── osiris-mcp/           # MCP client (stdio + HTTP) + crew tool adapter
│   ├── osiris-crew/          # Multi-agent orchestration (coordinator + delegation)
│   ├── osiris-backlog/       # File-based PM on a Git orphan branch
│   ├── osiris-telemetry/     # OpenTelemetry setup shared by server + desktop-host (in osiris-ide)
│   └── osiris-cli/           # The `osiris` command + REPL
├── operator/                 # osiris-kind-operator (Go/kubebuilder): CRDs + controllers
└── toolchain/
    ├── osiris-eslint-config/ # Shared flat ESLint config
    └── osiris-tsconfig/      # Shared TypeScript base configs
```

## Prerequisites

- **Node.js 22 LTS** (`nvm use` reads `.nvmrc`)
- **pnpm 9** (`corepack enable`)
- **Go 1.26** + `kind`/`kubectl`/`helm` for `operator/` work

## Quickstart

```bash
corepack enable
pnpm install

pnpm build        # build every package (Turborepo)
pnpm test         # vitest across packages
pnpm lint         # eslint (flat config)
pnpm typecheck    # tsc -b across the workspace
```

## Multi-agent crew, knowledge base & Git backlog

Osiris projects are driven from a `.osiris/` folder (the same folder VS Code reads
as `.vscode`, in the `osiris-ide` editor). Anything missing there falls back to the
bundled system template in `@richardblaha/osiris-config`.

```text
.osiris/
├── agents/     # crew members — <name>.md with a YAML frontmatter header
├── memory/     # knowledge base — every .md is chunked + indexed into ChromaDB
├── backlog/    # file-based PM — PROCESS.md + one sub-folder per workflow state
├── actions/    # portable CI templates (GitHub / Gitea / Forgejo Actions)
├── temp/       # agent scratchpads — always git-ignored
├── crew.json   # crew roster + coordinator policy
├── memory.json # ChromaDB connection + indexing policy
└── mcp.json    # MCP servers, merged with the editor's discovered set
```

The `osiris` CLI (`@richardblaha/osiris-cli`) ties it together:

```bash
osiris init                       # scaffold .osiris/ from the system template
osiris agent list                 # the crew defined in .osiris/agents/
osiris crew run "add a foo parser" # coordinator drives the lead agent; it delegates
osiris memory reindex             # (re)index .osiris/memory/ — incremental, content-addressed
osiris memory watch               # reindex automatically on every .osiris/memory/ change
osiris memory search "orphan branch"
osiris backlog new "Parser crash" --type bug
osiris backlog move 12 review     # git mv + one commit on the orphan branch osiris/backlog
osiris backlog push / pull        # sync osiris/backlog with a git remote (OSIRIS_BACKLOG_REMOTE)
osiris backlog lint               # static-check every task file
osiris serve                      # REST API + Kanban console at http://localhost:8080
                                  # or: docker compose -f apps/osiris-api/docker-compose.yml up --build
osiris doctor                     # health-check: git repo, .osiris/, agents, ChromaDB, MCP, backlog
osiris repl                       # interactive REPL with crew/backlog/memory in scope
```

- **Models** come from the VS Code Language Model API (`model: vscode-lm/…` in an
  agent file) when driven from the `osiris-ide` editor, which reaches this platform
  through the **LM proxy** (`@richardblaha/lm-proxy`, in `osiris-ide` — an
  OpenAI-compatible shim over `vscode.lm`, published as `OSIRIS_LM_PROXY_URL`).
  Headless CLI/CI runs use `OSIRIS_CREW_PROVIDER` / `OSIRIS_AI_API_KEY` instead.
- **MCP** servers are taken from `.osiris/mcp.json` (both the `servers` and the
  VS Code `mcpServers` key; `${workspaceFolder}` / `${env:VAR}` are expanded).
  An agent opts in with an `mcp` (all servers) or `mcp:<id>` selector in its
  `tools:` list; `@richardblaha/osiris-mcp` starts them (stdio or Streamable HTTP), exposes
  each tool as `<id>__<tool>`, and a server that won't start is skipped, not
  fatal. `osiris crew run --mcp` / `OSIRIS_MCP=1` forces the pool even when no
  agent asks. Osiris manages no credentials of its own.
- **All tool execution** runs inside the `.devcontainer` (Node 22 + a ChromaDB
  service; see `.devcontainer/docker-compose.yml`).
- **The backlog never touches source history** — it lives on the dedicated
  orphan branch `osiris/backlog`, operated through a worktree under `.osiris/temp/`.

In the `osiris-ide` editor, the **Osiris** sidebar view (`osiris-workspace`) shows
the Kanban backlog and a crew runner, and the **Osiris: Run Crew on a Task…** /
**Osiris: Open Console** commands drive this same server — all over
`@richardblaha/osiris-protocol`'s typed `ConsoleClient`.

See [docs/crew-architecture.md](docs/crew-architecture.md) for the full design.

## `osiris-kind-operator`

`operator/` is a Go/kubebuilder v4 project reconciling `OsirisProject` and
`OsirisSession` CRDs. Suspend/resume works by scaling a Deployment 0/1 based on a
`coordination.k8s.io/v1` `Lease` (activity) and `spec.desiredPhase`; the PVC is
created once and never deleted on suspend. See `operator/OSIRIS-SPEC.md` and
`.github/workflows/osiris-operator.yml` (envtest + `kind`-backed integration).

## Publishing the shared packages

`osiris-core`, `osiris-protocol`, `osiris-agent-core`, `osiris-mcp`, `osiris-config`
and `osiris-telemetry` are published to GitHub Packages (`@richardblaha/…`) so
`osiris-ide` can depend on them. Bump the version(s)
that changed, then push a tag matching `packages-v*` (or run the
`Publish Packages` workflow manually) — see `.github/workflows/publish-packages.yml`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md).
Security reports: [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE).
