-- Settings of the project itself, managed by system admins (role osiris-admin). One JSON value per key:
-- `features` (which tools and channels the project may use), `name` (display name), `archived` (removed).
CREATE TABLE project_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
