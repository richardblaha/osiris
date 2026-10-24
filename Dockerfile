# One Dockerfile, one image per service: docker build --target <gateway|control|runtime|operator|vitepress|web-events> .
# Every service runs TypeScript with tsx as the unprivileged node user, read-only root filesystem (tsx caches in /tmp).

FROM node:24-slim AS base
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/platform/package.json packages/platform/
COPY packages/core/package.json packages/core/
COPY packages/client/package.json packages/client/
COPY apps/osiris-pwa/package.json apps/osiris-pwa/
COPY server/gateway/package.json server/gateway/
COPY server/control/package.json server/control/
COPY apps/osiris/package.json apps/osiris/
COPY server/operator/package.json server/operator/
COPY server/vitepress/package.json server/vitepress/
COPY server/web-events/package.json server/web-events/
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

# Local GeoIP databases shared by control and analytics; lookups never send client IPs out.
FROM base AS geo-data
RUN node -e 'const z=require("zlib"),fs=require("fs");(async()=>{fs.mkdirSync("/app/geo",{recursive:true});for(const kind of ["city","asn"]){let ok=false;for(const d of [new Date(),new Date(new Date().getUTCFullYear(),new Date().getUTCMonth()-1,1)]){const url=`https://download.db-ip.com/free/dbip-${kind}-lite-${d.toISOString().slice(0,7)}.mmdb.gz`;const r=await fetch(url);if(r.ok){fs.writeFileSync(`/app/geo/${kind}.mmdb`,z.gunzipSync(Buffer.from(await r.arrayBuffer())));ok=true;break}}if(!ok)throw new Error(`Missing GeoIP ${kind}`)}})()'

FROM base AS control
COPY --from=geo-data /app/geo /app/geo
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
COPY apps/osiris/src apps/osiris/src
COPY apps/osiris/skills apps/osiris/skills
ENV PORT=8080 SKILLS_DIR=/app/apps/osiris/skills DATA_DIR=/data
WORKDIR /app/apps/osiris
USER node
CMD ["node_modules/.bin/tsx", "src/index.ts"]

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
