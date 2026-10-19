-- Settings for all of Osiris, set by system admins; key 'guards' holds the rules every tenant's assistant keeps to
CREATE TABLE system_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
