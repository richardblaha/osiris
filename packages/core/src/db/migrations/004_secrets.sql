-- Secrets (API keys, tokens) for MCP servers and the http_request tool. `owner` is '' for tenant-wide
-- secrets (admins) or the user's sub for personal ones. Values are sealed with SECRETS_KEY and are write-only:
-- the API never returns them. A secret is only ever sent to the hosts in `allowed_hosts` (JSON array).
CREATE TABLE secrets (
  owner TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  value_enc TEXT NOT NULL,
  allowed_hosts TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (owner, name)
);
