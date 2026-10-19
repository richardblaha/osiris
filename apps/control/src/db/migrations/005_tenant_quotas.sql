-- Limits a system admin sets for the tenant: a JSON object of TenantQuotas, missing or null = no limit
ALTER TABLE tenants ADD COLUMN quotas TEXT NOT NULL DEFAULT '{}';
