# @richardblaha/osiris-api

The Osiris API — a single Fastify process that fronts a workspace and its remote
dev sessions. It bundles four surfaces:

1. **Session API** (`/api/v1/sessions/*`) — create / inspect / suspend / resume /
   delete remote dev sessions. Each session is an `OsirisSession` custom resource
   reconciled by [`osiris-kind-operator`](../../operator); the cluster is the
   source of truth.
2. **Console API** (`/api/v1/{backlog,crew,memory}/*`) — an HTTP facade over the
   workspace's Git backlog, agent crew and knowledge base, consumed by the
   [`osiris-console`](../osiris-console) SPA.
3. **Smart-HTTP Git hosting** (`/git/<repo>.git/...`) — bare repos served through
   the system `git`, `init --bare` on first push.
4. **SPA** (`/`) — serves the built `osiris-console` bundle.

`GET /healthz` is unauthenticated. Everything else needs `Authorization: Bearer
<OSIRIS_SERVER_TOKEN>`, except `/git/`, which does its own HTTP Basic (any
username, password = the token). An empty token disables auth (tests / trusted
networks only).

## Modules

| File                     | Role                                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `app.ts`                 | `buildServer(options)` — the auth hook, error→status mapping, and every route                                |
| `index.ts`               | process entry: telemetry, executor selection, graceful shutdown                                              |
| `executors.ts`           | `SessionExecutor` interface + `StubSessionExecutor` (in-memory, no cluster)                                  |
| `kubernetes-executor.ts` | `KubernetesSessionExecutor` — CRUD + RFC 6902 JSON-Patch on the `OsirisSession` CR; activity bumps a `Lease` |
| `k8s-session-watch.ts`   | one process-wide informer; fans CR phase changes into the per-session SSE stream                             |
| `session-store.ts`       | `InMemorySessionStore` — latest-descriptor cache + per-session `EventEmitter` fanout for `GET …/events`      |
| `routes/console.ts`      | `/api/v1/{backlog,crew,memory}` routes + `CrewRunManager` (replay/stream live runs, persist finished ones)   |
| `console-workspace.ts`   | binds the console API to a real `.osiris/` workspace (backlog repo, memory store, crew) — lazy + memoised    |
| `git.ts`                 | `registerGitHosting()` — `/git/<repo>.git/...` piped to `git http-backend`, HTTP Basic, auto `init --bare`   |
| `spa.ts`                 | `registerSpa()` — hand-rolled static handler with `index.html` fallback for client-side routing              |
| `sse.ts`                 | `formatSseEvent()` — protocol event → SSE frame                                                              |

## Endpoints

**Sessions** — `POST /api/v1/sessions` · `GET /api/v1/sessions/:id` ·
`POST /api/v1/sessions/:id/{suspend,resume,activity}` ·
`DELETE /api/v1/sessions/:id` · `GET /api/v1/sessions/:id/events` (SSE)

**Backlog** — `GET /api/v1/backlog` · `GET|POST /api/v1/backlog/tasks` ·
`GET /api/v1/backlog/tasks/:id` · `GET /api/v1/backlog/tasks/:id/history` ·
`POST /api/v1/backlog/tasks/:id/move` · `POST /api/v1/backlog/{push,pull}`

**Crew** — `GET /api/v1/crew/agents` · `GET|POST /api/v1/crew/runs` ·
`GET /api/v1/crew/runs/:id` · `GET /api/v1/crew/runs/:id/events` (SSE)

**Memory** — `POST /api/v1/memory/search` · `POST /api/v1/memory/reindex`

**Git** — `GET|POST /git/:repo/*` &nbsp;·&nbsp; **Health** — `GET /healthz`

Sessions run against `osiris-kind` only when `OSIRIS_K8S_NAMESPACE` is set;
otherwise they fall back to an in-memory stub. The console API is mounted only
when the workspace has a `.osiris/` directory (or `OSIRIS_WORKSPACE_ROOT` is
set explicitly).

## Configuration

| Env var                                             | Purpose                                                                  |
| --------------------------------------------------- | ------------------------------------------------------------------------ |
| `OSIRIS_SERVER_TOKEN`                               | bearer token clients must present (unset → no auth, logged as a warning) |
| `OSIRIS_PUBLIC_URL`                                 | public origin, used for git/console URLs                                 |
| `PORT` / `HOST`                                     | listen address (default `8080` / `0.0.0.0`)                              |
| `OSIRIS_K8S_NAMESPACE`                              | namespace holding the `OsirisSession` CRs — enables the real executor    |
| `OSIRIS_GIT_REPOS_DIR`                              | directory of bare repos — enables `/git/` hosting                        |
| `OSIRIS_WORKSPACE_ROOT`                             | workspace the console API drives (default: cwd)                          |
| `OSIRIS_CONSOLE`                                    | set to `0` to disable the console API                                    |
| `OSIRIS_CONSOLE_SPA_DIR`                            | override the console `dist/` location                                    |
| `OSIRIS_CHROMA_URL`                                 | ChromaDB endpoint (unset → local file-backed memory store)               |
| `OSIRIS_CREW_PROVIDER`                              | headless crew model provider (`echo`, …) + `OSIRIS_AI_API_KEY`           |
| `OSIRIS_BACKLOG_REMOTE` / `OSIRIS_BACKLOG_AUTOPUSH` | backlog orphan-branch sync                                               |
| `OSIRIS_MCP`                                        | `1` to start MCP servers for crew runs                                   |
| `OTEL_EXPORTER_OTLP_ENDPOINT`                       | OpenTelemetry collector (traces + metrics + logs)                        |

```bash
OSIRIS_SERVER_TOKEN=… OSIRIS_GIT_REPOS_DIR=/srv/osiris/repos \
  OSIRIS_WORKSPACE_ROOT=/srv/osiris/workspace \
  node dist/index.js
```

## Container

`Dockerfile` is a multi-stage build (`pnpm deploy` for a self-contained runtime
image); `docker-compose.yml` brings it up alongside ChromaDB.
`docker-entrypoint.sh` `git init`s the mounted `/workspace` if it isn't a repo
yet.

```bash
docker compose -f apps/osiris-api/docker-compose.yml up --build
```

Built with `tsc` (NodeNext). Routes are covered end-to-end with `fastify.inject`,
including a real `git init --bare` + `info/refs` round-trip. CI:
`.github/workflows/osiris-server.yml` (memory ⇄ ChromaDB integration + image
build & API smoke).
