# Osiris Crew Architecture — Implementation Plan & Technical Reference

Status: **implemented** 2026-09-02 — `@osiris/{dot-osiris,memory,crew,backlog,cli}`,
console API + SPA, DevContainer. `pnpm build && lint && typecheck && test` green.

This document is both the Phase‑1 implementation checklist (with acceptance
criteria) and the living technical reference for the multi‑agent orchestration,
Git‑based project management and VS Code / Dev Container integration added to
Osiris.

---

## 0. Architectural guard‑rails (locked)

| #   | Constraint                                                                                                                          | Consequence                                                                                            |
| --- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 1   | **No `CLAUDE.md`.** `README.md` is the single source of project instructions.                                                       | Crew system prompts are assembled from `README.md` + `.osiris/agents/*.md`.                            |
| 2   | **VS Code Language Model API / Copilot Chat** provides model selection. No hard‑coded API keys where the editor API can supply one. | `@osiris/crew` model resolution has a `vscode-lm` provider adapter; keychain/env is the fallback only. |
| 3   | **MCP discovery from the VS Code / Dev Container environment.**                                                                     | Crew reads `.osiris/mcp.json` + the editor's contributed MCP servers; nothing bespoke.                 |
| 4   | **All tool execution runs inside `.devcontainer`.**                                                                                 | ChromaDB, the crew runtime and `osiris-server` all have a container story; host is orchestration only. |
| 5   | **`.osiris/` is the fallback + init skeleton.** Missing project config falls back to the bundled system template.                   | `@osiris/dot-osiris` ships `template/` and a layered resolver.                                         |
| 6   | **Backlog lives on an orphan branch** (`osiris/backlog`), never polluting `main` / `feature/*` history.                             | `@osiris/backlog` drives a dedicated git worktree; state moves are `git mv` + commit.                  |
| 7   | **`.osiris/temp/` is always git‑ignored.**                                                                                          | `ensureGitignore()` is idempotently applied by init and the CLI.                                       |

---

## 1. `.osiris/` layout

```
.osiris/
├── agents/            # crew member definitions — <name>.md with YAML frontmatter
├── memory/            # knowledge base — every .md (recursive) is chunked + indexed
├── backlog/           # file-based PM — PROCESS.md + state sub-folders
│   ├── PROCESS.md
│   ├── todo/
│   ├── in-progress/
│   ├── review/
│   └── done/
├── actions/           # CI/CD workflow templates (GitHub / Gitea / Forgejo Actions)
├── temp/              # agent scratchpads — ALWAYS gitignored
├── crew.json          # crew roster + coordinator policy (optional; template default)
├── memory.json        # ChromaDB connection + indexing policy (optional)
└── mcp.json           # MCP servers merged with the editor's discovered set (optional)
```

Existing VS Code workspace files (`launch.json`, `tasks.json`, `settings.json`,
`extensions.json`) continue to live at `.osiris/` root — the folder is a superset.

### Agent definition (`.osiris/agents/<name>.md`)

```markdown
---
name: architect
role: Senior Systems Architect
specialization: system design, API contracts, trade-off analysis
model: vscode-lm/claude-opus-5 # provider/model; falls back to crew default
tools: [memory_search, read_file, backlog_read]
delegateTo: [implementer, reviewer] # who this agent may hand subtasks to
temperature: 0.2
---

System behaviour instructions in Markdown prose…
```

**Acceptance:** `parseAgentDefinition()` round-trips every field; an unknown
`model` provider resolves to the crew default with a warning; a file with no
frontmatter is rejected with a clear error citing the path.

---

## 2. Implementation checklist

### Phase A — `@osiris/dot-osiris` (layout, template, init) ✅ scaffold

- [x] `layout.ts` — path constants + `OsirisPaths(root)` resolver
- [x] `resolve.ts` — layered read: project `.osiris/…` → bundled `template/…`
- [x] `gitignore.ts` — idempotent `ensureGitignore(root)` adds `.osiris/temp/`
- [x] `init.ts` — `initWorkspace(root, { force })` scaffolds the skeleton
- [x] `template/` — the shipped default skeleton (agents, PROCESS.md, crew.json…)
- [x] tests: layout, resolve fallback, gitignore idempotency, init dry-run
- **Acceptance:** `initWorkspace` on an empty dir produces a working `.osiris/`;
  re-running is a no-op; `resolveOsirisFile('agents/architect.md')` returns the
  project file when present and the template file otherwise.

### Phase B — `@osiris/memory` (ChromaDB knowledge base) ✅ scaffold

- [x] `chunk.ts` — heading-aware Markdown splitter (`chunkMarkdown`, size/overlap)
- [x] `hash.ts` — stable content + file digests (`sha256`)
- [x] `cache.ts` — `IndexCache` over `.osiris/temp/memory-index.json` (file → digest → chunk ids)
- [x] `dedupe.ts` — drop chunks whose content digest is already indexed
- [x] `store.ts` — `MemoryStore` interface + `InMemoryMemoryStore` (HNSW-config-carrying) + `ChromaMemoryStore`
- [x] `embed.ts` — `EmbeddingFn`: `hashEmbedding` (offline/deterministic) + `openAiCompatibleEmbedding` + `ollamaEmbedding`
- [x] `indexer.ts` — `reindex(paths)` — incremental, dedup, HNSW, cache-backed
- [x] tests: chunker boundaries, cache hit/miss, dedupe, indexer incremental no-op
- **Acceptance:** second `reindex()` with no file changes performs **zero**
  embedding calls and **zero** upserts; changing one file re-embeds only its
  chunks; HNSW params (`space: cosine`, `M`, `efConstruction`) are passed on
  collection create.

### Phase C — `@osiris/crew` (multi-agent orchestration) ✅ scaffold

- [x] `definition.ts` — `parseAgentDefinition` / `serializeAgentDefinition` (frontmatter)
- [x] `registry.ts` — `AgentRegistry.load(dotOsiris)` from `.osiris/agents/`
- [x] `blackboard.ts` — shared append-only fact store for a crew run
- [x] `model-resolution.ts` — `resolveProvider(spec, providers)` (`vscode-lm` seam)
- [x] `tools/` — `memory_search`, `delegate`, `backlog_read` bridge tools
- [x] `crew.ts` — `Crew.run(task)` — coordinator drives lead agent; `delegate`
      spawns a sub-`AgentOrchestrator` per specialist; events streamed
- [x] tests (with `EchoProviderAdapter`): delegation path, blackboard accrual,
      max-depth guard, unknown-agent delegate error
- **Acceptance:** a lead agent that emits a `delegate` tool call to `implementer`
  runs the implementer with its own system prompt/tools and folds the result
  back; recursion beyond `maxDepth` is refused, not hung.

### Phase D — `@osiris/backlog` (Git orphan-branch PM) ✅ scaffold

- [x] `task.ts` — `parseTaskFilename` / `formatTaskFilename` (`[<type>]-<id>-<slug>.md`), frontmatter body
- [x] `states.ts` — ordered workflow states, derived from sub-folders
- [x] `git-runner.ts` — `GitRunner` interface + `ExecaGitRunner` + `FakeGitRunner`
- [x] `orphan.ts` — `ensureOrphanBranch(runner, branch)` + dedicated worktree under `.osiris/temp/backlog-worktree`
- [x] `repo.ts` — `BacklogRepo`: `list()`, `get(id)`, `create(input)`, `move(id, toState)` (= `git mv` + commit), `history(id)`
- [x] tests: filename round-trip, state ordering, `FakeGitRunner` move sequence,
      one integration test against a real temp repo (create → move → log)
- **Acceptance:** `move()` produces exactly one commit on `osiris/backlog` and
  **no** change to the working tree of `main`; `list()` groups tasks by state
  folder; a malformed filename is skipped with a warning, not a throw.

### Phase E — `apps/osiris-server` REST + SPA ✅ scaffold

- [x] `routes/backlog.ts` — `GET /api/v1/backlog`, `GET/POST /api/v1/backlog/tasks`, `POST …/tasks/:id/move`
- [x] `routes/crew.ts` — `GET /api/v1/crew/agents`, `POST /api/v1/crew/runs` (+ SSE `…/runs/:id/events`)
- [x] `routes/memory.ts` — `POST /api/v1/memory/search`, `POST /api/v1/memory/reindex`
- [x] static SPA mount (`@fastify/static`) from `@osiris/console` `dist/`
- [x] `@osiris/protocol` — zod schemas for all of the above (`crew.ts`, `backlog.ts`, `memory.ts`)
- [x] tests: backlog CRUD+move over a `FakeGitRunner`, crew run lifecycle, memory search shape
- **Acceptance:** `curl` against a temp repo can create a task, move it, and see
  it on the board; `GET /` serves the SPA; every route validates its body via zod
  and 400s on bad input.

### Phase F — `apps/osiris-console` (SPA) ✅ scaffold

- [x] Vite + React + TypeScript, no runtime CSS framework (system font, tokens)
- [x] Kanban board (columns = states, drag → `move`), Agents panel, Memory search
- [x] `api.ts` thin fetch client against `@osiris/protocol` types
- [x] build to `dist/`, wired into server `files` + Docker
- **Acceptance:** `pnpm --filter @osiris/console build` emits a static bundle;
  board reflects server state and a card drag issues one `move` call.

### Phase G — `@osiris/cli` (`osiris` binary + REPL) ✅ scaffold

- [x] `osiris init` — `initWorkspace`
- [x] `osiris memory reindex` / `osiris memory search <q>`
- [x] `osiris agent list` / `osiris crew run "<task>"`
- [x] `osiris backlog list|new|move`
- [x] `osiris serve` — boots `osiris-server` against the cwd
- [x] `osiris repl` — node:repl with `crew`, `memory`, `backlog` in scope
- **Acceptance:** `osiris --help` lists all commands; `osiris backlog new "[bug] parser crash"` writes a task and commits it to the orphan branch.

### Phase H — Dev Container + integration

- [x] repo-root `.devcontainer/devcontainer.json` + `docker-compose.yml` (adds a `chromadb` service)
- [x] `.osiris/mcp.json` template + `OSIRIS_*` env wiring (`OSIRIS_CHROMA_URL`, …)
- [x] `.osiris/` in **this** repo scaffolded with real starter agents + `PROCESS.md`
- [x] root `tsconfig.json` refs + `.osiris/tasks.json` + CI (`ci.yml`) updated
- [x] `README.md` + this doc updated
- **Acceptance:** `pnpm build && pnpm lint && pnpm typecheck && pnpm test` all green;
  `.osiris/temp/` is git-ignored; opening the repo in the Dev Container brings up
  ChromaDB and `osiris serve` works end to end.

---

## 3. Package graph (additions)

```
@osiris/protocol ─┬─> @osiris/backlog ─┐
                  ├─> @osiris/memory ──┼─> @osiris/crew ─> osiris-ai (ext), @osiris/cli
                  └─> @osiris/dot-osiris ┘        │
                                                 └─> @osiris/server ─> @osiris/console (SPA, build-time)
```

`@osiris/dot-osiris`, `@osiris/memory`, `@osiris/backlog` depend only on
`@osiris/shared-core` (+ `@osiris/protocol` for shared types). `@osiris/crew`
builds on `@osiris/agent-core`.

## 4. Conventions carried over

- Pure logic is unit-tested; Docker / ChromaDB-server / real-git edges sit behind
  an interface with an in-memory fake and are exercised by one integration test.
- ESM only, `tsc` emit to `dist/`, `composite` project refs, `vitest run`.
- No secret is ever persisted; API keys come from `context.secrets` / env at call time.
