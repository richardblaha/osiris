-- Remote MCP servers whose tools the tenant's agent may use. Headers (e.g. Authorization) are
-- encrypted with SECRETS_KEY (see src/secrets.ts) and never returned by the API.
CREATE TABLE mcp_servers (
  name TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  headers_enc TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
