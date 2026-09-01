# @osiris/web

Browser-served Osiris IDE runtime, following the **OpenVSCode Server** pattern.
Like `@osiris/desktop`, it clones a pinned upstream tag at build time and applies
the Osiris `product.json` overlay — no VS Code source is vendored.

## Run locally

```bash
pnpm --filter @osiris/web run prepare:shell    # clone gitpod-io/openvscode-server @ config/upstream.json + brand
pnpm --filter @osiris/web build                # build the web server bundle (heavy)
node apps/osiris-web/server/index.mjs --port 3000
# open http://localhost:3000
```

`server/index.mjs` is a thin wrapper: it parses a stable CLI (`--port`, `--host`,
`--token`), forces `OSIRIS_TELEMETRY=off`, sets the server data dir, prints a
banner, and execs the upstream server entrypoint with the rest of the args.
`node server/index.mjs --help` works even without a build (used as a CI smoke test).

## Docker

```bash
# build context is the REPO ROOT so the workspace is available
docker build -f apps/osiris-web/Dockerfile -t osiris-web .
docker run --rm -p 3000:3000 osiris-web
```

Multi-stage: the build stage clones + brands + builds; the runtime stage is
`node:22-bookworm-slim`, non-root (`uid 1001`), `EXPOSE 3000`, with a healthcheck.

## Files

| Path                           | Role                                                    |
| ------------------------------ | ------------------------------------------------------- |
| `config/upstream.json`         | pinned OpenVSCode Server repo + tag                     |
| `scripts/clone-upstream.mjs`   | idempotent shallow clone                                |
| `scripts/apply-branding.mjs`   | product.json overlay (+ telemetry off)                  |
| `scripts/lib.mjs`              | `mergeDeep`, overlay loader, entrypoint finder (tested) |
| `server/index.mjs`             | Osiris CLI wrapper around the upstream server           |
| `Dockerfile` / `.dockerignore` | container image                                         |
