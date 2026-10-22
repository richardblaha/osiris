# One Dockerfile, one image per service: docker build --target <gateway|control|runtime|operator|sites|vitepress|web-events> .
# Every service runs TypeScript with tsx as the unprivileged node user, read-only root filesystem (tsx caches in /tmp).

FROM node:24-slim AS base
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/platform/package.json packages/platform/
COPY packages/core/package.json packages/core/
COPY apps/web/package.json apps/web/
COPY apps/gateway/package.json apps/gateway/
COPY apps/control/package.json apps/control/
COPY apps/runtime/package.json apps/runtime/
COPY apps/operator/package.json apps/operator/
COPY apps/sites/package.json apps/sites/
COPY apps/vitepress/package.json apps/vitepress/
COPY apps/web-events/package.json apps/web-events/
ENV NODE_ENV=production
EXPOSE 8080

FROM base AS web-build
RUN NODE_ENV=development pnpm install --frozen-lockfile --filter "@osiris/web..."
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN pnpm --filter @osiris/web build

FROM base AS gateway
RUN pnpm install --frozen-lockfile --prod --filter "@osiris/gateway..." && pnpm store prune
COPY packages/shared/src packages/shared/src
COPY packages/platform/src packages/platform/src
COPY apps/gateway/src apps/gateway/src
COPY --from=web-build /app/apps/web/dist apps/web/dist
ENV PORT=3001 STATIC_DIR=/app/apps/web/dist
WORKDIR /app/apps/gateway
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
COPY apps/control/src apps/control/src
ENV PORT=3002
WORKDIR /app/apps/control
USER node
CMD ["node_modules/.bin/tsx", "src/index.ts"]

FROM base AS runtime
RUN pnpm install --frozen-lockfile --prod --filter "@osiris/runtime..." && pnpm store prune
COPY packages/shared/src packages/shared/src
COPY packages/platform/src packages/platform/src
COPY packages/core/src packages/core/src
COPY apps/runtime/src apps/runtime/src
COPY apps/runtime/skills apps/runtime/skills
ENV PORT=8080 SKILLS_DIR=/app/apps/runtime/skills DATA_DIR=/data
WORKDIR /app/apps/runtime
USER node
CMD ["node_modules/.bin/tsx", "src/index.ts"]

FROM base AS operator
RUN pnpm install --frozen-lockfile --prod --filter "@osiris/operator..." && pnpm store prune
COPY packages/shared/src packages/shared/src
COPY packages/platform/src packages/platform/src
COPY apps/operator/src apps/operator/src
WORKDIR /app/apps/operator
USER node
CMD ["node_modules/.bin/tsx", "src/index.ts"]

FROM base AS sites
RUN pnpm install --frozen-lockfile --prod --filter "@osiris/sites..." && pnpm store prune
COPY packages/shared/src packages/shared/src
COPY packages/platform/src packages/platform/src
COPY apps/sites/src apps/sites/src
ENV PORT=8080
WORKDIR /app/apps/sites
USER node
CMD ["node_modules/.bin/tsx", "src/index.ts"]

FROM base AS vitepress
RUN apt-get update && apt-get install -y --no-install-recommends tini && rm -rf /var/lib/apt/lists/*
RUN pnpm install --frozen-lockfile --prod --filter "@osiris/vitepress..." && pnpm store prune
COPY apps/vitepress/src apps/vitepress/src
ENV PORT=3000 ISOLATED_BUILDS=true
WORKDIR /app/apps/vitepress
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
COPY apps/web-events/src apps/web-events/src
ENV PORT=8080
WORKDIR /app/apps/web-events
USER node
CMD ["node_modules/.bin/tsx", "src/index.ts"]
