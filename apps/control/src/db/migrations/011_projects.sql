-- Tenants became projects: the table, every tenant_id column and the claim keys of users
ALTER TABLE tenants RENAME TO projects;
ALTER TABLE wa_selection RENAME COLUMN tenant_id TO project_id;
ALTER TABLE schedules RENAME COLUMN tenant_id TO project_id;
ALTER TABLE schedule_runs RENAME COLUMN tenant_id TO project_id;
ALTER TABLE domains RENAME COLUMN tenant_id TO project_id;
ALTER TABLE site_releases RENAME COLUMN tenant_id TO project_id;
ALTER TABLE backups RENAME COLUMN tenant_id TO project_id;
ALTER TABLE dashboards RENAME COLUMN tenant_id TO project_id;
DROP INDEX domains_tenant;
CREATE INDEX domains_project ON domains (project_id);
DROP INDEX backups_tenant;
CREATE INDEX backups_project ON backups (project_id, created_at);
DROP INDEX dashboards_tenant;
CREATE INDEX dashboards_project ON dashboards (project_id);
UPDATE users SET claims = replace(replace(claims, '"tenant-admin":', '"project-admin":'), '"tenant":', '"project":'), claims_version = claims_version + 1 WHERE claims LIKE '%"tenant%';
