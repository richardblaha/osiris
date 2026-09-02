# syntax=docker/dockerfile:1

# ---- build stage: clone upstream, brand it, build the web server ----
FROM node:26-bookworm AS build
WORKDIR /osiris

RUN apt-get update && apt-get install -y --no-install-recommends \
      git python3 make g++ pkg-config \
      libx11-dev libxkbfile-dev libsecret-1-dev libkrb5-dev ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable

# Workspace context (repo root is the build context).
COPY . .
RUN pnpm install --frozen-lockfile --filter @osiris/web... \
    && pnpm --filter @osiris/branding build \
    && pnpm --filter @osiris/branding render:icons \
    && pnpm --filter @osiris/web run prepare:shell \
    && pnpm --filter @osiris/web build:shell

# ---- runtime stage ----
FROM node:26-bookworm-slim AS runtime
LABEL org.opencontainers.image.title="Osiris IDE (web)" \
      org.opencontainers.image.source="https://github.com/osiris-ide/osiris" \
      org.opencontainers.image.licenses="MIT"

RUN groupadd --gid 1001 osiris && useradd --uid 1001 --gid osiris --create-home osiris
WORKDIR /home/osiris/app

# Ship only the runtime wrapper + the built server bundle — not the multi-GB
# upstream source checkout under .build/server.
COPY --from=build --chown=osiris:osiris /osiris/apps/osiris-web/server ./apps/osiris-web/server
COPY --from=build --chown=osiris:osiris /osiris/apps/osiris-web/scripts ./apps/osiris-web/scripts
COPY --from=build --chown=osiris:osiris /osiris/apps/osiris-web/config ./apps/osiris-web/config
COPY --from=build --chown=osiris:osiris /osiris/apps/osiris-web/package.json ./apps/osiris-web/package.json
COPY --from=build --chown=osiris:osiris /osiris/apps/osiris-web/.build/vscode-reh-web-linux-x64 ./apps/osiris-web/.build/vscode-reh-web-linux-x64
COPY --from=build --chown=osiris:osiris /osiris/packages/branding ./packages/branding

ENV OSIRIS_TELEMETRY=off \
    VSCODE_SERVER_DATA_DIR=/home/osiris/.osiris-server \
    NODE_ENV=production

USER osiris
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["node", "apps/osiris-web/server/index.mjs"]
CMD ["--host", "0.0.0.0", "--port", "3000"]
