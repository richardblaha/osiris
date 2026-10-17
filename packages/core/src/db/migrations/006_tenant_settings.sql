-- Settings of the tenant itself, managed by system admins (role osiris-admin). One JSON value per key:
-- `features` (which tools and channels the tenant may use), `name` (display name), `archived` (removed).
CREATE TABLE tenant_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
