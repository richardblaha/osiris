CREATE TABLE auth_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  at INTEGER NOT NULL,
  success INTEGER NOT NULL,
  method TEXT NOT NULL,
  ip TEXT NOT NULL,
  location TEXT NOT NULL
);
CREATE INDEX auth_events_user_time ON auth_events(user_id, at);
CREATE TABLE auth_session_info (
  uid TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_seen_at INTEGER NOT NULL,
  ip TEXT NOT NULL,
  location TEXT NOT NULL
);
CREATE TABLE auth_session_revocations (
  uid TEXT PRIMARY KEY,
  at INTEGER NOT NULL
);
