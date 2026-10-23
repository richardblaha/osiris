-- Schema of one project's database. Every project has its own database (see src/projects/), so no table
-- carries a project_id. Users and projects themselves live in PocketID; user_id is the OIDC `sub`.

CREATE TABLE threads (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('web', 'whatsapp')),
  title TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX threads_user ON threads(user_id, updated_at);

CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Vectors are stored as libSQL vector32 blobs and searched with an exact scan; a project's corpus is small.
CREATE TABLE chunks (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  content TEXT NOT NULL,
  embedding_model TEXT NOT NULL,
  embedding BLOB NOT NULL
);
CREATE INDEX chunks_model ON chunks(embedding_model);
CREATE INDEX chunks_document ON chunks(document_id);

-- Project-specific skills; a row overrides a bundled skill (apps/api/skills/) with the same name.
CREATE TABLE skills (
  name TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  instructions TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Long-term agent memory. user_id NULL means shared with everyone in the project.
CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX memories_user ON memories(user_id, created_at);

-- LangGraph checkpoints (see src/checkpointer/libsql-saver.ts). Channel values live in checkpoint_blobs,
-- stored once per (channel, version), so unchanged state such as message history isn't copied into every checkpoint.
CREATE TABLE checkpoints (
  thread_id TEXT NOT NULL,
  checkpoint_ns TEXT NOT NULL DEFAULT '',
  checkpoint_id TEXT NOT NULL,
  parent_checkpoint_id TEXT,
  type TEXT,
  checkpoint BLOB,
  metadata BLOB,
  PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
);

CREATE TABLE checkpoint_blobs (
  thread_id TEXT NOT NULL,
  checkpoint_ns TEXT NOT NULL DEFAULT '',
  channel TEXT NOT NULL,
  version TEXT NOT NULL,
  type TEXT NOT NULL,
  blob BLOB,
  PRIMARY KEY (thread_id, checkpoint_ns, channel, version)
);

CREATE TABLE checkpoint_writes (
  thread_id TEXT NOT NULL,
  checkpoint_ns TEXT NOT NULL DEFAULT '',
  checkpoint_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  channel TEXT NOT NULL,
  type TEXT,
  value BLOB,
  PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
);
