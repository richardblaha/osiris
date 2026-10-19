-- Built-in tools a system admin switched off for the tenant: a JSON array of tool names
ALTER TABLE tenants ADD COLUMN disabled_tools TEXT NOT NULL DEFAULT '[]';
