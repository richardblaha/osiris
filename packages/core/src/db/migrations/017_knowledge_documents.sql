-- The knowledge base is no longer files: each document is a row here (id like cenik.md or public/cenik.md, its
-- chunks keyed by path knowledge/<id>); the files once in knowledge/ move here at the project's init
CREATE TABLE knowledge_documents (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
