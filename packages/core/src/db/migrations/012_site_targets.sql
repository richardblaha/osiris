-- Where the tenant's website is published over SFTP (e.g. its VPS at vas-hosting.cz): the server, the folder, the
-- password or private key (sealed), the server's host key pinned on the first connection, and the last publish
CREATE TABLE site_targets (
  name TEXT PRIMARY KEY,
  host TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 22,
  username TEXT NOT NULL,
  remote_dir TEXT NOT NULL,
  auth TEXT NOT NULL,
  secret_enc TEXT NOT NULL,
  host_key TEXT,
  last_publish TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
