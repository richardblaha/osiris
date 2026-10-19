-- How the assistant behaves, tenant-wide (owner '') or for one user (owner = the user's sub): a persona, written from a
-- character the admin or user named (JSON {character, source, description}), and rules ("guards") it must keep
CREATE TABLE assistant_profiles (
  owner TEXT PRIMARY KEY,
  persona TEXT,
  guards TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
