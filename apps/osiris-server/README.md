# @osiris/server

The Osiris Server — Fastify. Implements the **session-handover migration
protocol** from [`@osiris/protocol`](../../packages/protocol), **smart-HTTP Git
hosting**, and **resumable volume transfer**. Workspace provisioning and the
hosted Web IDE launcher (`WebIdeLauncher`) are still seams.

| Module               | Role                                                                            |
| -------------------- | ---------------------------------------------------------------------------- |
| `app.ts`             | `buildServer(options)` — every `/api/v1` route, bearer auth, error mapping    |
| `session-store.ts`   | `InMemorySessionStore` — the lease/etag state machine (`local ⇄ in-transit ⇄ server`), expiry sweep, event emitter |
| `executors.ts`       | `HandoverExecutor` + `VolumeStore` (`InMemoryVolumeStore` / `FileVolumeStore` — assemble `Content-Range` chunks, digest, serve back); `StubHandoverExecutor` |
| `docker-executor.ts` | `DockerHandoverExecutor` — real `provision` / `freezeForFetch` / `teardown` via `@osiris/container-sync` `thaw()`/`freeze()` + a `WebIdeLauncher` |
| `git.ts`             | `registerGitHosting()` — `/git/<repo>.git/...` proxied to the system `git` (`git-http-backend`), auto-`init --bare` on first push |
| `lease.ts` · `sse.ts`| lease etag/TTL helpers · SSE frame formatting                                  |
| `index.ts`           | process entry: telemetry + `listen`                                            |

```bash
OSIRIS_SERVER_TOKEN=… OSIRIS_PUBLIC_URL=https://osiris.example.com \
  OSIRIS_GIT_REPOS_DIR=/srv/osiris/repos \
  OTEL_EXPORTER_OTLP_ENDPOINT=http://collector:4318 \
  node dist/index.js            # PORT (8080), HOST (0.0.0.0)
```

### Protocol surface

`POST /sessions` · `GET /sessions/:id` · `POST /sessions/:id/handover/{prepare,commit,abort,finalize}`
· `PUT|GET /sessions/:id/volume` · `POST /sessions/:id/fetch/{prepare,commit}` ·
`POST /sessions/:id/lease/renew` · `GET /sessions/:id/events` (SSE) ·
`GET|POST /git/:repo/*` · `GET /healthz`

Mutations after `/prepare` require `If-Match: <lease etag>`; the new etag comes
back in `ETag`. An unfinished transfer whose lease TTL (10 min) elapses is
auto-aborted to its prior location. Volume uploads may be a single `PUT` or
`Content-Range` chunks (`308` until the final chunk carries the real total).

Built with `tsc` (NodeNext). Routes are covered end-to-end with `fastify.inject`
(incl. a real `git init --bare` + `info/refs` round-trip).
