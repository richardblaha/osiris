# Knowledge base

Every `.md` file under `.osiris/memory/` (recursively, including sub-folders) is
semantically chunked and indexed into ChromaDB by `@richardblaha/osiris-memory`.

Guidelines:

- **One idea per file.** Small, focused notes retrieve better than sprawling docs.
- **Lead with a heading.** The chunker is heading-aware; a good `#`/`##`
  structure produces good chunks.
- **Write durable facts**, not transient status. Decisions, conventions,
  gotchas, external references.
- Re-indexing is incremental and content-addressed: unchanged files cost
  nothing, and duplicate passages are stored once.

Run `osiris memory reindex` after editing, or let the editor watcher do it.
