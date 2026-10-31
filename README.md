# Osiris

A multi-project AI assistant for tradespeople and small businesses: jobs, scheduling, notes, invoices, a knowledge
base, files, a small database, websites and customer-facing assistants. Each project gets its own LangGraph agent in
its own container. People use it from a web app (an installable PWA) and from WhatsApp.

The UI and the services' messages are available in English (the default) and Czech.

## Layout

| Path | What it is |
| --- | --- |
| `server/auth` | osiris-auth: the OpenID Connect provider (auth.k6labs.cz), users, groups, apps, SCIM |
| `server/gateway` | The only entry from the internet: token introspection, access checks, routing to control and project runtimes |
| `server/control` | Projects and their members, WhatsApp, scheduler, backups, dashboards |
| `apps/osiris` | The agent: one process per project (or `osiris <folder>` locally), with the project's API, database and files |
| `server/operator` | Kubernetes operator for `Project` resources (scale to zero, snapshots) |
| `apps/osiris-pwa` | React web app (Assistant UI) |
| `apps/osiris-cli`, `apps/osiris-desktop`, `apps/osiris-vscode` | Terminal, desktop (Tauri) and VS Code clients for a local agent or the server |
| `server/vitepress`, `server/web-events`, `server/tts` | The VitePress builder for project websites, cookieless web analytics, text to speech |
| `server/digital-twin` | The digital twin (twin.k6labs.cz): a 3D view of systems from DTDL models, telemetry from ClickHouse |
| `packages/core` | The agent core: graph, checkpointer, RAG, MCP, vault, files |
| `packages/tools/*` | The agent's built-in tools, one package per function |
| `packages/client` | The API client every client uses |
| `packages/shared` | Types shared with the web app, locale helpers, theme and icons |
| `packages/platform` | Service plumbing: internal JWT, SQLite (`LocalDb`), object storage, telemetry, service message catalogs |

[CLAUDE.md](CLAUDE.md) describes the architecture in detail; [deploy/README.md](deploy/README.md) covers production.

## Getting started

Requires Node.js 24 or newer and pnpm.

```bash
pnpm install
pnpm --filter @osiris/platform gen-keys   # internal JWT key pair, master key and sign-in keys for the .env files
pnpm dev                                  # gateway :3001, control :3002 (starts runtimes on :4100+), osiris-auth :3003, vitepress :3005, web :5173
node apps/osiris/bin/osiris.mjs <folder>  # or just the agent over a folder, without the server
```

Each app reads its `.env` (see the `.env.example` next to it). Locally, control needs no S3 or email: it uses a
SQLite file, a folder and the log. To skip sign-in, set `AUTH_DEV_BYPASS=true` for the gateway and `VITE_DEV_USER` for
the web app (for example `root:role=osiris-admin`). `DEFAULT_LOCALE` (`en` or `cs`) sets the language of messages that
no request asked for in a language, such as WhatsApp replies.

```bash
pnpm typecheck   # tsc in every package
pnpm test        # vitest in every package with tests
```

There is no linter or formatter; `typecheck` and `test` are the checks.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md), including how to add or improve a translation.

## License

[MIT](LICENSE)
