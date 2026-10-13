# One image for the whole app: the API (run by tsx) also serves the built web client (STATIC_DIR).

FROM node:24-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @osiris/web build

FROM node:24-slim
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile --prod --filter "@osiris/api..." && pnpm store prune
COPY packages/shared packages/shared
COPY apps/api/src apps/api/src
COPY apps/api/skills apps/api/skills
COPY apps/api/tsconfig.json apps/api/
COPY --from=build /app/apps/web/dist apps/web/dist

ENV NODE_ENV=production \
    PORT=3001 \
    STATIC_DIR=/app/apps/web/dist \
    SKILLS_DIR=/app/apps/api/skills \
    TENANT_DATA_DIR=/data/tenants
WORKDIR /app/apps/api
USER node
EXPOSE 3001
CMD ["node_modules/.bin/tsx", "src/index.ts"]
