-- Settings of the tenant itself, managed by system admins (group osiris-admin). One JSON value per key,
-- e.g. `features` (which tools and channels the tenant may use).
CREATE TABLE tenant_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
