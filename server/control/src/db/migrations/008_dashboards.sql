-- Dashboards of the system (tenant_id NULL, system admins) and of tenants (their admins), the definition as JSON
-- (DashboardDefinition); the built-in ones live in the web app, not here
CREATE TABLE dashboards (
  id TEXT PRIMARY KEY,
  tenant_id TEXT,
  name TEXT NOT NULL,
  definition TEXT NOT NULL,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX dashboards_tenant ON dashboards (tenant_id);
-- The web analytics sites (web-events) a tenant sees besides those of its domains, a JSON array set by system admins
ALTER TABLE tenants ADD COLUMN web_sites TEXT NOT NULL DEFAULT '[]';
-- What the tenant's runtime last reported of its use (ReportedUsage as JSON) and when
ALTER TABLE tenants ADD COLUMN usage TEXT;
ALTER TABLE tenants ADD COLUMN usage_at INTEGER;
