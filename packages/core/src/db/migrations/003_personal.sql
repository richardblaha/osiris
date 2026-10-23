-- Personal settings next to the project-wide ones. `owner` is '' for project-wide rows (managed by admins)
-- or the user's OIDC sub for personal rows (visible to and managed by that user only).
-- '' rather than NULL so (owner, name) can be a primary key.

CREATE TABLE skills_v2 (
  owner TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  instructions TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (owner, name)
);
INSERT INTO skills_v2 (owner, name, description, instructions, updated_at)
  SELECT '', name, description, instructions, updated_at FROM skills;
DROP TABLE skills;
ALTER TABLE skills_v2 RENAME TO skills;

-- Server names stay unique across the whole project (tool names are `<server>_<tool>`); the API enforces that.
CREATE TABLE mcp_servers_v2 (
  owner TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  headers_enc TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (owner, name)
);
INSERT INTO mcp_servers_v2 (owner, name, url, headers_enc, enabled, created_at, updated_at)
  SELECT '', name, url, headers_enc, enabled, created_at, updated_at FROM mcp_servers;
DROP TABLE mcp_servers;
ALTER TABLE mcp_servers_v2 RENAME TO mcp_servers;
CREATE INDEX mcp_servers_name ON mcp_servers(name);

ALTER TABLE documents ADD COLUMN owner TEXT NOT NULL DEFAULT '';
CREATE INDEX documents_owner ON documents(owner);

-- "Můj profil": how the agent should treat this user.
CREATE TABLE user_settings (
  user_id TEXT PRIMARY KEY,
  address TEXT NOT NULL DEFAULT 'auto' CHECK (address IN ('auto', 'ty', 'vy')),
  language TEXT NOT NULL DEFAULT 'auto' CHECK (language IN ('auto', 'cs', 'sk')),
  signature TEXT NOT NULL DEFAULT '',
  instructions TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
