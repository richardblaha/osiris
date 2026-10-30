-- Central database (SQLite). Times are epoch milliseconds passed in by the application. Statements end with ";" at
-- the end of a line, which is where the runner splits them

CREATE TABLE tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  -- active | archived (removed from everyone's claims; runtime suspended, volume and backups kept)
  status TEXT NOT NULL DEFAULT 'active',
  -- JSON object of TenantFeatures overrides; features missing here default to on
  features TEXT NOT NULL DEFAULT '{}',
  -- Minutes without activity before the runtime is put to sleep; 0 = always on
  idle_minutes INTEGER NOT NULL DEFAULT 30,
  storage_gb INTEGER NOT NULL DEFAULT 5,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- WhatsApp messages as Meta delivered them, handled in order per sender by the inbox worker
CREATE TABLE wa_inbox (
  message_id TEXT PRIMARY KEY,
  from_number TEXT NOT NULL,
  phone_number_id TEXT NOT NULL,
  type TEXT NOT NULL,
  text TEXT,
  received_at INTEGER NOT NULL,
  -- pending | processing | done | failed
  status TEXT NOT NULL DEFAULT 'pending',
  claim TEXT,
  lease_until INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER NOT NULL,
  error TEXT
);
CREATE INDEX wa_inbox_pending ON wa_inbox (status, next_at);
CREATE INDEX wa_inbox_sender ON wa_inbox (from_number, status);

-- The tenant a WhatsApp user picked with /tenant
CREATE TABLE wa_selection (
  user_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- A user proves a phone number by sending the code from it to our WhatsApp number
CREATE TABLE phone_challenges (
  user_id TEXT PRIMARY KEY,
  phone TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE schedules (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  owner_name TEXT,
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  -- Either a cron expression (repeating) or run_at (once)
  cron TEXT,
  run_at INTEGER,
  timezone TEXT NOT NULL,
  -- web | whatsapp: where the result goes (whatsapp also leaves it in a web thread)
  delivery TEXT NOT NULL DEFAULT 'web',
  enabled INTEGER NOT NULL DEFAULT 1,
  next_run_at INTEGER,
  -- Retries of the current occurrence
  attempts INTEGER NOT NULL DEFAULT 0,
  claim TEXT,
  lease_until INTEGER,
  last_run_at INTEGER,
  last_status TEXT,
  last_error TEXT,
  last_thread_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX schedules_due ON schedules (enabled, next_run_at);
CREATE INDEX schedules_owner ON schedules (tenant_id, owner_id);

CREATE TABLE schedule_runs (
  id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  due_at INTEGER NOT NULL,
  -- done | failed | skipped
  status TEXT NOT NULL,
  thread_id TEXT,
  error TEXT,
  finished_at INTEGER NOT NULL
);
CREATE INDEX schedule_runs_schedule ON schedule_runs (schedule_id, finished_at);

-- Custom domains of tenant sites. A domain is served only once verified (DNS TXT challenge + points at us)
CREATE TABLE domains (
  domain TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  -- pending | verified | failed
  status TEXT NOT NULL DEFAULT 'pending',
  token TEXT NOT NULL,
  release_id TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  verified_at INTEGER,
  checked_at INTEGER
);
CREATE INDEX domains_tenant ON domains (tenant_id);

CREATE TABLE site_releases (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  domain TEXT NOT NULL,
  files INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  created_by TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX site_releases_domain ON site_releases (domain, created_at);

-- Snapshots of tenant runtimes (database + files) in object storage
CREATE TABLE backups (
  key TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX backups_tenant ON backups (tenant_id, created_at);
