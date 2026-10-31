# One Dockerfile, one image per service: docker build --target <gateway|auth|control|runtime|operator|vitepress|web-events|digital-twin|digital-twin-alerts|tts> .
# Every service runs TypeScript with tsx as the unprivileged node user, read-only root filesystem (tsx caches in /tmp).

FROM node:24-slim AS base
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/platform/package.json packages/platform/
COPY packages/core/package.json packages/core/
COPY packages/client/package.json packages/client/
COPY packages/tools/ceph/package.json packages/tools/ceph/
COPY packages/tools/database/package.json packages/tools/database/
COPY packages/tools/digital-twin/package.json packages/tools/digital-twin/
COPY packages/tools/files/package.json packages/tools/files/
COPY packages/tools/http/package.json packages/tools/http/
COPY packages/tools/images/package.json packages/tools/images/
COPY packages/tools/integrations/package.json packages/tools/integrations/
COPY packages/tools/knowledge/package.json packages/tools/knowledge/
COPY packages/tools/kubernetes/package.json packages/tools/kubernetes/
COPY packages/tools/memory/package.json packages/tools/memory/
COPY packages/tools/ops/package.json packages/tools/ops/
COPY packages/tools/scheduler/package.json packages/tools/scheduler/
COPY packages/tools/sites/package.json packages/tools/sites/
COPY packages/tools/skills/package.json packages/tools/skills/
COPY packages/tools/workflows/package.json packages/tools/workflows/
COPY apps/osiris-pwa/package.json apps/osiris-pwa/
COPY server/gateway/package.json server/gateway/
COPY server/auth/package.json server/auth/
COPY server/auth/web/package.json server/auth/web/
COPY server/control/package.json server/control/
COPY apps/osiris/package.json apps/osiris/
COPY server/operator/package.json server/operator/
COPY server/vitepress/package.json server/vitepress/
COPY server/web-events/package.json server/web-events/
COPY server/digital-twin/package.json server/digital-twin/
COPY server/digital-twin/web/package.json server/digital-twin/web/
ENV NODE_ENV=production
EXPOSE 8080

FROM base AS web-build
RUN NODE_ENV=development pnpm install --frozen-lockfile --filter "@osiris/pwa..."
COPY packages/shared packages/shared
COPY packages/client packages/client
COPY apps/osiris-pwa apps/osiris-pwa
RUN pnpm --filter @osiris/pwa build

FROM base AS gateway
RUN pnpm install --frozen-lockfile --prod --filter "@osiris/gateway..." && pnpm store prune
COPY packages/shared/src packages/shared/src
COPY packages/platform/src packages/platform/src
COPY server/gateway/src server/gateway/src
COPY --from=web-build /app/apps/osiris-pwa/dist apps/osiris-pwa/dist
ENV PORT=3001 STATIC_DIR=/app/apps/osiris-pwa/dist
WORKDIR /app/server/gateway
USER node
CMD ["node_modules/.bin/tsx", "src/index.ts"]

# Local GeoIP databases shared by osiris-auth (sign-in history) and analytics; lookups never send client IPs out.
FROM base AS geo-data
RUN node -e 'const z=require("zlib"),fs=require("fs");(async()=>{fs.mkdirSync("/app/geo",{recursive:true});for(const kind of ["city","asn"]){let ok=false;for(const d of [new Date(),new Date(new Date().getUTCFullYear(),new Date().getUTCMonth()-1,1)]){const url=`https://download.db-ip.com/free/dbip-${kind}-lite-${d.toISOString().slice(0,7)}.mmdb.gz`;const r=await fetch(url);if(r.ok){fs.writeFileSync(`/app/geo/${kind}.mmdb`,z.gunzipSync(Buffer.from(await r.arrayBuffer())));ok=true;break}}if(!ok)throw new Error(`Missing GeoIP ${kind}`)}})()'

# The identity provider's pages (sign-in, account, administration), in the PWA's design system.
FROM base AS auth-web-build
RUN NODE_ENV=development pnpm install --frozen-lockfile --filter "@osiris/auth-web..."
COPY packages/shared packages/shared
COPY apps/osiris-pwa/src/index.css apps/osiris-pwa/src/theme.css apps/osiris-pwa/src/
COPY apps/osiris-pwa/src/fonts apps/osiris-pwa/src/fonts
COPY server/auth/web server/auth/web
RUN pnpm --filter @osiris/auth-web build

# osiris-auth: the identity provider (OpenID Connect, users, groups, apps, SCIM), with its own SQLite on a volume
# (DATA_DIR), serving its pages.
FROM base AS auth
COPY --from=geo-data /app/geo /app/geo
RUN pnpm install --frozen-lockfile --prod --filter "@osiris/auth..." && pnpm store prune
COPY packages/shared/src packages/shared/src
COPY packages/platform/src packages/platform/src
COPY server/auth/src server/auth/src
COPY --from=auth-web-build /app/server/auth/web/dist server/auth/web/dist
ENV PORT=3003 STATIC_DIR=/app/server/auth/web/dist DATA_DIR=/data
WORKDIR /app/server/auth
USER node
CMD ["node_modules/.bin/tsx", "src/index.ts"]

FROM base AS control
RUN pnpm install --frozen-lockfile --prod --filter "@osiris/control..." && pnpm store prune
COPY packages/shared/src packages/shared/src
COPY packages/platform/src packages/platform/src
COPY server/control/src server/control/src
ENV PORT=3002
WORKDIR /app/server/control
USER node
CMD ["node_modules/.bin/tsx", "src/index.ts"]

FROM base AS runtime
# git: a project folder can be a working tree of its repository (connected, committed, pulled and pushed by its admins).
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
RUN pnpm install --frozen-lockfile --prod --filter "@osiris/agent..." && pnpm store prune
COPY packages/shared/src packages/shared/src
COPY packages/platform/src packages/platform/src
COPY packages/core/src packages/core/src
COPY packages/tools/ceph/src packages/tools/ceph/src
COPY packages/tools/database/src packages/tools/database/src
COPY packages/tools/digital-twin/src packages/tools/digital-twin/src
COPY packages/tools/files/src packages/tools/files/src
COPY packages/tools/http/src packages/tools/http/src
COPY packages/tools/images/src packages/tools/images/src
COPY packages/tools/integrations/src packages/tools/integrations/src
COPY packages/tools/knowledge/src packages/tools/knowledge/src
COPY packages/tools/kubernetes/src packages/tools/kubernetes/src
COPY packages/tools/memory/src packages/tools/memory/src
COPY packages/tools/ops/src packages/tools/ops/src
COPY packages/tools/scheduler/src packages/tools/scheduler/src
COPY packages/tools/sites/src packages/tools/sites/src
COPY packages/tools/skills/src packages/tools/skills/src
COPY packages/tools/workflows/src packages/tools/workflows/src
COPY apps/osiris/src apps/osiris/src
COPY apps/osiris/skills apps/osiris/skills
ENV PORT=8080 SKILLS_DIR=/app/apps/osiris/skills DATA_DIR=/data
WORKDIR /app/apps/osiris
USER node
CMD ["node_modules/.bin/tsx", "src/index.ts"]

# The local agent's image (`osiris <folder>` runs it, launcher.ts): the runtime with the PWA, started as cli.ts over
# /project, and the gate (gate-cli.ts) from the same image. Run as the user's uid, so nothing here is written to.
FROM runtime AS local
COPY --from=web-build /app/apps/osiris-pwa/dist apps/osiris-pwa/dist
ENV STATIC_DIR=/app/apps/osiris-pwa/dist
CMD ["node_modules/.bin/tsx", "src/cli.ts", "/project"]

FROM base AS operator
RUN pnpm install --frozen-lockfile --prod --filter "@osiris/operator..." && pnpm store prune
COPY packages/shared/src packages/shared/src
COPY packages/platform/src packages/platform/src
COPY server/operator/src server/operator/src
WORKDIR /app/server/operator
USER node
CMD ["node_modules/.bin/tsx", "src/index.ts"]

FROM base AS vitepress
RUN apt-get update && apt-get install -y --no-install-recommends tini && rm -rf /var/lib/apt/lists/*
RUN pnpm install --frozen-lockfile --prod --filter "@osiris/vitepress..." && pnpm store prune
COPY server/vitepress/src server/vitepress/src
ENV PORT=3000 ISOLATED_BUILDS=true
WORKDIR /app/server/vitepress
USER node
# tini (PID 1) reaps what the builds leave; the server, its only child, kills every other process after each build
# (src/build.ts), so it runs as one process, without the tsx CLI wrapper.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--import", "tsx", "src/index.ts"]

# DB-IP Lite (CC BY 4.0, https://db-ip.com); runtime refreshes monthly releases in /tmp.
FROM base AS web-events
COPY --from=geo-data /app/geo /app/geo
RUN pnpm install --frozen-lockfile --prod --filter "@osiris/web-events..." && pnpm store prune
COPY packages/shared/src packages/shared/src
COPY packages/platform/src packages/platform/src
COPY server/web-events/src server/web-events/src
ENV PORT=8080
WORKDIR /app/server/web-events
USER node
CMD ["node_modules/.bin/tsx", "src/index.ts"]

# The digital twin's PWA (three.js WebGL, the OSIRIS theme), served by the API below.
FROM base AS twin-web-build
RUN NODE_ENV=development pnpm install --frozen-lockfile --filter "@osiris/digital-twin-web..."
COPY packages/shared packages/shared
COPY packages/client packages/client
COPY server/digital-twin/web server/digital-twin/web
RUN pnpm --filter @osiris/digital-twin-web build

# Osiris Digital Twin: the cluster's digital twin — structure from the Kubernetes API, telemetry from ClickHouse —
# serving its PWA, and the ops API: kubectl (the cluster's minor version) and ceph (Ceph's Squid client, else the
# distribution's) for Osiris's agent.
FROM base AS digital-twin
ARG KUBECTL_VERSION=v1.35.6
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
 && . /etc/os-release \
 && curl -fsSL https://download.ceph.com/keys/release.asc | gpg --dearmor -o /usr/share/keyrings/ceph.gpg \
 && echo "deb [signed-by=/usr/share/keyrings/ceph.gpg] https://download.ceph.com/debian-squid/ ${VERSION_CODENAME} main" > /etc/apt/sources.list.d/ceph.list \
 && (apt-get update && apt-get install -y --no-install-recommends ceph-common \
     || (rm /etc/apt/sources.list.d/ceph.list && apt-get update && apt-get install -y --no-install-recommends ceph-common)) \
 && curl -fsSLo /usr/local/bin/kubectl "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/$(dpkg --print-architecture)/kubectl" \
 && chmod 0755 /usr/local/bin/kubectl \
 && apt-get purge -y gnupg curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
RUN pnpm install --frozen-lockfile --prod --filter "@osiris/digital-twin..." && pnpm store prune
COPY packages/shared/src packages/shared/src
COPY packages/platform/src packages/platform/src
COPY server/digital-twin/src server/digital-twin/src
COPY --from=twin-web-build /app/server/digital-twin/web/dist server/digital-twin/web/dist
ENV PORT=3004 STATIC_DIR=/app/server/digital-twin/web/dist
WORKDIR /app/server/digital-twin
USER node
CMD ["node_modules/.bin/tsx", "src/index.ts"]

# The digital twin's alerting (server/digital-twin/src/alerts): the collector's warn/error events become alerts that
# Osiris's agent investigates, each in a conversation of its own. No kubectl, ceph or PWA.
FROM base AS digital-twin-alerts
RUN pnpm install --frozen-lockfile --prod --filter "@osiris/digital-twin..." && pnpm store prune
COPY packages/shared/src packages/shared/src
COPY packages/platform/src packages/platform/src
COPY server/digital-twin/src server/digital-twin/src
ENV PORT=3006
WORKDIR /app/server/digital-twin
USER node
CMD ["node_modules/.bin/tsx", "src/alerts/index.ts"]

# Osiris speech: Piper TTS with Czech (jirka) and English (lessac) voices, an HTTP service inside the cluster. The
# build speaks a sentence, so a broken voice or API never ships.
FROM python:3.12-slim AS tts
ARG PIPER_VOICES=https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0
WORKDIR /app
COPY server/tts/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
ADD ${PIPER_VOICES}/cs/cs_CZ/jirka/medium/cs_CZ-jirka-medium.onnx ${PIPER_VOICES}/cs/cs_CZ/jirka/medium/cs_CZ-jirka-medium.onnx.json /voices/
ADD ${PIPER_VOICES}/en/en_US/lessac/medium/en_US-lessac-medium.onnx ${PIPER_VOICES}/en/en_US/lessac/medium/en_US-lessac-medium.onnx.json /voices/
COPY server/tts/server.py ./
RUN chmod -R a+r /voices && python -c "import server; assert len(server.synthesize('Dobrý den, tady Osiris.', 'cs')) > 10000; assert len(server.synthesize('Hello.', 'en')) > 5000"
ENV PYTHONUNBUFFERED=1 PORT=8080
USER 1000
CMD ["python", "server.py"]
