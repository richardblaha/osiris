# `.osiris/`

This folder is the Osiris workspace control plane. It is also the VS Code
workspace config folder (Osiris reads `.vscode` as `.osiris`), so editor files
(`launch.json`, `tasks.json`, `settings.json`, `extensions.json`) live here too.

| Folder        | Purpose                                                                 | Git |
|---------------|------------------------------------------------------------------------|-----|
| `agents/`     | Crew member definitions — one `<name>.md` per agent (YAML frontmatter). | committed |
| `memory/`     | Knowledge base. Every `.md` (recursive) is chunked and indexed into ChromaDB. | committed |
| `backlog/`    | File-based project management. `PROCESS.md` + one sub-folder per workflow state. | **orphan branch** `osiris/backlog` |
| `actions/`    | CI/CD workflow templates (GitHub / Gitea / Forgejo Actions).           | committed |
| `temp/`       | Agent scratchpads and caches.                                          | **git-ignored** |

Config files at the root of `.osiris/`:

- `crew.json` — crew roster + coordinator policy.
- `memory.json` — ChromaDB connection + indexing policy.
- `mcp.json` — MCP servers, merged with the ones the editor discovers.

Anything missing here falls back to the bundled system template in
`@osiris/dot-osiris`. Run `osiris init` to materialise the full skeleton.
