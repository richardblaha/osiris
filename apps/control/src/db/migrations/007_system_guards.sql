-- The rules every tenant's assistant keeps to, one row per guard (name, description, the rule as Markdown); the old
-- text in system_settings 'guards' becomes a guard per line at control's start (TenantStore.migrateSystemGuards)
CREATE TABLE system_guards (
  name TEXT PRIMARY KEY,
  description TEXT NOT NULL DEFAULT '',
  rule TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
