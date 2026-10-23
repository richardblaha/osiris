-- Users get their own layer over the project's settings again: their own knowledge base documents (owner = sub,
-- '' for the project's) and memories that may replace one of the project's for them (overrides = its id)
CREATE TABLE knowledge_documents_v2 (
  owner TEXT NOT NULL DEFAULT '',
  id TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (owner, id)
);
INSERT INTO knowledge_documents_v2 (owner, id, title, content, created_at, updated_at)
  SELECT '', id, title, content, created_at, updated_at FROM knowledge_documents;
DROP TABLE knowledge_documents;
ALTER TABLE knowledge_documents_v2 RENAME TO knowledge_documents;

ALTER TABLE memories ADD COLUMN overrides TEXT;
