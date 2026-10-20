-- Threads may be on the public channel too (the tenant's customers, owner public:<visitor>); SQLite can't change a
-- CHECK constraint, so the table is rebuilt with the same rows
CREATE TABLE threads_v2 (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('web', 'whatsapp', 'public')),
  title TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO threads_v2 (id, user_id, channel, title, created_at, updated_at) SELECT id, user_id, channel, title, created_at, updated_at FROM threads;
DROP TABLE threads;
ALTER TABLE threads_v2 RENAME TO threads;
CREATE INDEX threads_user ON threads(user_id, updated_at);
