# Osiris

A multi-project AI assistant for tradespeople and small businesses: jobs, scheduling, notes, invoices, a knowledge
base, files, a small database, websites and customer-facing assistants. Each project gets its own LangGraph agent in
its own container. People use it from a web app (an installable PWA) and from WhatsApp.

The UI and the services' messages are available in English (the default) and Czech.

## Layout

| Path | What it is |
| --- | --- |
| `server/gateway` | The only entry from the internet: sign-in passthrough, access checks, routing to control and project runtimes |
| `server/control` | OpenID Connect provider, users, projects, WhatsApp, scheduler, backups, dashboards |
| `apps/osiris` | One process per project: the agent and the project's API, database and files |
| `server/operator` | Kubernetes operator for `Project` resources (scale to zero, snapshots) |
| `apps/osiris-pwa` | React web app (Assistant UI) |
| `server/sites`, `server/vitepress`, `server/web-events` | Project websites, the VitePress builder, cookieless web analytics |
| `packages/shared` | Types shared with the web app, locale helpers |
| `packages/platform` | Service plumbing: internal JWT, rqlite, object storage, telemetry, service message catalogs |
| `packages/core` | The agent: graph, tools, checkpointer, RAG, MCP, vault, files |

[CLAUDE.md](CLAUDE.md) describes the architecture in detail; [deploy/README.md](deploy/README.md) covers production.

## Getting started

Requires Node.js 24 or newer and pnpm.

```bash
pnpm install
pnpm --filter @osiris/platform gen-keys   # internal JWT key pair, master key and sign-in keys for the .env files
pnpm dev                                  # gateway :3001, control :3002 (starts runtimes on :4100+), web :5173
```

Each app reads its `.env` (see the `.env.example` next to it). Locally, control needs no rqlite, S3 or SMTP: it uses a
SQLite file, a folder and the log. To skip sign-in, set `AUTH_DEV_BYPASS=true` for the gateway and `VITE_DEV_USER` for
the web app (for example `root:role=osiris-admin`). `DEFAULT_LOCALE` (`en` or `cs`) sets the language of messages that
no request asked for in a language, such as WhatsApp replies.

```bash
pnpm typecheck   # tsc in every package
pnpm test        # vitest in every package with tests
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md), including how to add or improve a translation.

## License

[MIT](LICENSE)
