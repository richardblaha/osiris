# Osiris Server — central Git hosting + the crew / backlog / memory console API.
# Build from the repo root:  docker build -f apps/osiris-server/Dockerfile -t osiris-server .

# ---- build ----------------------------------------------------------------
FROM node:22-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /repo

COPY . .
RUN pnpm install --frozen-lockfile
# `@richardblaha/osiris-server...` builds the server and every workspace package it depends on.
RUN pnpm --filter @richardblaha/osiris-server... build
RUN pnpm --filter @richardblaha/osiris-console build
# Self-contained deployment of just the server (workspace deps inlined).
RUN pnpm --filter @richardblaha/osiris-server --prod deploy /app

# ---- runtime ------------------------------------------------------------
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app

COPY --from=build /app ./
# The SPA the server serves at `/` (index.ts looks for ../public first).
COPY --from=build /repo/apps/osiris-console/dist ./public
COPY apps/osiris-server/docker-entrypoint.sh /usr/local/bin/osiris-entrypoint
RUN chmod +x /usr/local/bin/osiris-entrypoint

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    OSIRIS_TELEMETRY=off \
    OSIRIS_STATE_DIR=/data/state \
    OSIRIS_GIT_REPOS_DIR=/data/git \
    OSIRIS_WORKSPACE_ROOT=/workspace \
    OSIRIS_CREW_PROVIDER=echo

RUN mkdir -p /data/state /data/git /workspace
VOLUME ["/data"]
EXPOSE 8080

# Osiris runs the crew's tools; `git config --global` keeps the backlog worktree happy.
RUN git config --system user.email "osiris@localhost" && git config --system user.name "Osiris" \
  && git config --system --add safe.directory '*' && git config --system init.defaultBranch main

CMD ["osiris-entrypoint"]
