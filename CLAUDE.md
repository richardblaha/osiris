# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Multi-tenant SaaS assistant for tradespeople and small-business owners (jobs, scheduling, notes, invoices). The LangGraph agent runs in our own Node server. The clients are a web chat (Assistant UI) and, later, WhatsApp. Users write in Czech and Slovak, so the prompts and the UI are in Czech.

## Commands

pnpm workspace, Node ≥ 24. Run these from the repo root:

```bash
pnpm install
pnpm dev                 # API (:3001) + web (:5173, proxies /api to the API)
pnpm typecheck           # tsc in every package
pnpm test                # vitest (API only)
pnpm --filter @osiris/api exec vitest run test/app.test.ts      # one file
pnpm --filter @osiris/api exec vitest run -t "tool call"         # by test name
pnpm --filter @osiris/api migrate <tenant>...                    # migrate tenant DBs ahead of time (the server migrates each on first open)
```

Configuration lives in `apps/api/.env` and `apps/web/.env`, with `.env.example` next to each. For local work without PocketID, set `AUTH_DEV_BYPASS=true` (API) and `VITE_DEV_USER=<name>` (web). The bearer token is then `<user>` (admin of their own tenant `<user>`) or `<user>:<group>,<group>` to simulate PocketID groups. Config validation refuses this in production.

## Architecture

- `packages/shared`: types shared by the API and the web client (`RunEvent` SSE protocol, `ThreadMessage`). Imported as TS source, with no build step.
- `apps/api`: Hono server run by `tsx`.
- `apps/web`: Vite + React, `oidc-client-ts`, Assistant UI primitives.

**Identity lives only in PocketID.** We store no users, tenants or memberships. `auth/oidc.ts` verifies the access token against the issuer's JWKS and reads profile, custom claims and `groups` from `/userinfo`, cached for 60 s per token. PocketID access tokens carry only `sub`, and custom claims are released only in the ID token and userinfo. The phone number is the user custom claim `phone_number`. The web client requests the scopes `openid profile email groups`.

**Tenancy = PocketID groups** (`auth/tenants.ts`). The group `tenant-<slug>` makes a user a member and `tenant-<slug>-admin` an admin, so a slug can't end in `-admin`. Users with no tenant group get 403. `authMiddleware` authenticates. `tenantMiddleware` picks the active tenant from the `X-Tenant-Id` header, which must be one of the memberships. `/me` is registered between the two, so a client can list its tenants before picking one.

**One database per tenant** (`tenants/`). The `TenantRegistry` lazily locates the tenant's DB, migrates it and builds the tenant's stores, checkpointer and agent graph, then caches them. Locally each tenant is `TENANT_DATA_DIR/<slug>.db`. With `TURSO_*` set, each tenant is a Turso database `osiris-<slug>`, created through the Platform API on first use and opened with a group token. The schema (`db/migrations/*.sql`) is the tenant schema and has no `tenant_id` columns, because the database itself is the boundary. The runner splits on `;` at line ends, so don't add triggers. There is no global database, Postgres or Qdrant.

**Agent** (`agent/graph.ts`): a hand-built ReAct `StateGraph` (`agent` ↔ `tools`) over `MessagesAnnotation`, compiled once per tenant with tools bound to that tenant's stores (`tenants/tenant.ts`). Per-run identity (`thread_id`, `tenant_id`, `user_id`, `role`, `channel`) is passed in `config.configurable` (`agent/context.ts`). The graph refuses a run whose `tenant_id` isn't its own. Tools read the user and role from the run context and never from model arguments. The system prompt is built per call, with the channel format, the date, the skill list and the user's memories, and is not checkpointed.

**Skills** (`agent/skills.ts`): bundled skills are folders `apps/api/skills/<name>/SKILL.md` (`SKILLS_DIR`) with frontmatter `name` (kebab-case, same as the folder) and `description`, followed by Czech instructions. They load at startup, and an invalid skill stops the server from starting. Tenant admins add their own skills (table `skills`, `/api/skills`). A tenant skill overrides a bundled skill with the same name. The prompt lists only name and description, and the model loads the body with `load_skill`.

**Memory** (`agent/memory.ts`, table `memories`): long-term facts that are either personal (`user_id`) or shared with the tenant (`user_id` NULL, admin only). The model writes them with the `remember` and `forget` tools, users manage them at `/api/memories`, and they're injected into the prompt as data, not instructions.

**MCP servers** (`mcp/`, table `mcp_servers`): tenant admins register remote MCP servers (`/api/mcp-servers`, "Nástroje (MCP)" in the web app). Only http(s) is allowed, never stdio. `mcp/url.ts` requires https and public addresses to prevent SSRF from inside the cluster. `MCP_ALLOW_PRIVATE` lifts that in development. Headers are sealed with `SECRETS_KEY` (`secrets.ts`), and the API returns only their names. `McpToolset` connects lazily, opening one `MCPAdapter` per server so a failing server is skipped, and caches tools for 5 minutes. Config changes call `invalidate()`. The graph resolves these `dynamicTools` on every model and tool step, so changes apply without recompiling. Tool names are `<server>_<tool>`.

**Checkpointer** (`checkpointer/libsql-saver.ts`): custom libSQL port of the official `PostgresSaver` layout. Channel values go to `checkpoint_blobs`, keyed by (channel, version), so message history isn't duplicated in every checkpoint. `test/checkpointer.test.ts` runs the official `@langchain/langgraph-checkpoint-validation` suite (~700 tests) and must stay green after any change.

**RAG** (`rag/store.ts`): chunks are stored as libSQL `vector32` blobs in the tenant's DB and searched with an exact `vector_distance_cos` scan filtered by `embedding_model`. Changing `EMBEDDING_MODEL` hides old vectors until documents are re-ingested.

**Models** come from `provider:model` specs (`LLM_MODEL`, `EMBEDDING_MODEL`); defaults are Mistral Small 4 (`mistralai:mistral-small-2603`) and `mistralai:mistral-embed`, both via `MISTRAL_API_KEY`. Chat models go through LangChain `initChatModel`, so a new provider only needs its `@langchain/<provider>` package installed. Embeddings support `openai:` and `mistralai:` (`rag/embeddings.ts`).

**Web streaming.** `POST /api/threads/:id/runs` sends only the new user message, because the server holds history in the checkpointer. It streams `RunEvent`s as SSE. `web/src/chat/adapter.ts` turns them into Assistant UI parts for `useLocalRuntime`. History is loaded once via `GET /threads/:id/messages` as `initialMessages`. `ChatPane` is remounted (`key`) to switch threads. A new thread is created lazily on first send.

## Gotchas

- In tests, `:memory:` libSQL loses data across `batch` transactions, so use `createTestDb()` (one tenant DB) or `createTestTenants()` (registry over temp files) from `test/helpers.ts`. `ScriptedChatModel` and `WordEmbeddings` there replace real providers.
- Vitest runs with `globals: true` because the checkpoint validation suite needs Jest-style globals.
- The concurrent-run guard in `app.ts` (`activeRuns`) and the tenant cache are in-process only. A shared lock is needed before the API runs with more than one replica.
- WhatsApp (not built yet) has no token, so mapping phone → user will need the PocketID admin API (`GET /api/users` with `X-API-KEY`, which returns `customClaims`).
- The workspace root `.env` and `.kubeconfig` hold local credentials and are gitignored. Never commit or print them.

## Deployment

Production runs at https://osiris.k6labs.cz in the `abydos` k3s cluster (namespace `osiris`). CI pushes the `ghcr.io/richardblaha/osiris` image on `main`, and the manifests live in `deploy/k8s` (kustomize). In the image the API also serves the web build (`STATIC_DIR`), and the web client reads its OIDC settings at runtime from `/config.js`. See `deploy/README.md` for secrets, PocketID setup and rollout.
