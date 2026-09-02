# Crew, memory and the Git backlog

- **Crew** (`@osiris/crew`): agents are `.osiris/agents/<name>.md` (YAML
  frontmatter + Markdown system prompt). A coordinator drives the `lead` agent
  from `crew.json`; the `delegate` tool spawns a sub-`AgentOrchestrator` per
  specialist. Depth, per-agent iterations and total delegations are bounded by
  `crew.json`'s `coordinator` policy. Model selection goes through the VS Code
  Language Model API when in the editor (`vscode-lm/<model>`), with a headless
  fallback for CLI/CI.
- **Memory** (`@osiris/memory`): every `.md` under `.osiris/memory/` is
  heading-chunked and indexed into ChromaDB (HNSW, cosine). Re-indexing is
  content-addressed — unchanged files and previously-embedded passages cost
  nothing.
- **Backlog** (`@osiris/backlog`): tasks are `[<type>]-<id>-<slug>.md` files;
  the workflow state is the sub-folder. The whole backlog lives on the
  **orphan branch `osiris/backlog`** in a worktree under `.osiris/temp/`, so it
  never pollutes `main`/`feature/*` history. A move = `git mv` + one commit.

There is **no `CLAUDE.md`** — `README.md` is the single source of project
instructions and is folded into every agent's system prompt.
