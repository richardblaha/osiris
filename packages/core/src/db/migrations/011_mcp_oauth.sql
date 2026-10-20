-- How an MCP server is signed in to: 'headers' (static, sealed in headers_enc) or 'oauth' (the owner signs in at the
-- provider, e.g. portal.vas-hosting.cz)
ALTER TABLE mcp_servers ADD COLUMN auth TEXT NOT NULL DEFAULT 'headers';

-- OAuth of an MCP server per owner: the registered client, the tokens and a pending sign-in's code verifier (sealed),
-- and that sign-in's state value, to find it again when the provider sends the user back
CREATE TABLE mcp_oauth (
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  data_enc TEXT NOT NULL,
  state TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (owner, name)
);
CREATE UNIQUE INDEX mcp_oauth_state ON mcp_oauth(state);
