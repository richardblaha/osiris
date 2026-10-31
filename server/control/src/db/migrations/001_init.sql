-- Control's database (SQLite): projects, WhatsApp, the scheduler, backups, system settings and rules, dashboards. Users
-- and groups are osiris-auth's. Times are epoch milliseconds passed in by the application. Statements end with ";" at
-- the end of a line, which is where the runner splits them
--
-- baseline after: 012_no_cluster_sites.sql
-- A database from before drops control's old sign-in tables (users moved to osiris-auth), children first:
-- baseline drops: auth_events, auth_session_info, auth_session_revocations, recovery_codes, passkeys, user_identities, login_links, auth_challenges, oidc_store, users

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  -- active | archived
  status TEXT NOT NULL DEFAULT 'active',
  -- JSON ProjectFeatures
  features TEXT NOT NULL DEFAULT '{}',
  idle_minutes INTEGER NOT NULL DEFAULT 30,
  storage_gb INTEGER NOT NULL DEFAULT 5,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  -- The logo's version (served at /project-logos/<id>/<version>); NULL = none
  logo TEXT,
  -- JSON list of built-in tools a system admin switched off
  disabled_tools TEXT NOT NULL DEFAULT '[]',
  -- JSON quotas; a missing one = no limit
  quotas TEXT NOT NULL DEFAULT '{}',
  -- JSON list of the web-events sites the project sees in Traffic
  web_sites TEXT NOT NULL DEFAULT '[]',
  -- JSON usage the runtime last reported, and when
  usage TEXT,
  usage_at INTEGER
);

-- WhatsApp messages as received, answered one at a time per sender
CREATE TABLE wa_inbox (
  message_id TEXT PRIMARY KEY,
  from_number TEXT NOT NULL,
  phone_number_id TEXT NOT NULL,
  type TEXT NOT NULL,
  text TEXT,
  received_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  claim TEXT,
  lease_until INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER NOT NULL,
  error TEXT
);

CREATE INDEX wa_inbox_pending ON wa_inbox (status, next_at);

CREATE INDEX wa_inbox_sender ON wa_inbox (from_number, status);

-- The project a WhatsApp user chose with /project
CREATE TABLE wa_selection (
  user_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Delivery statuses of the messages sent, only ever moving forward
CREATE TABLE wa_deliveries (
  message_id TEXT PRIMARY KEY,
  phone_number_id TEXT NOT NULL,
  recipient TEXT NOT NULL,
  status TEXT NOT NULL,
  status_at INTEGER NOT NULL,
  error_code TEXT
);

CREATE INDEX wa_deliveries_time ON wa_deliveries (status_at);

-- Phone verification: the user sends OVERENI <code> from that phone
CREATE TABLE phone_challenges (
  user_id TEXT PRIMARY KEY,
  phone TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL
);

-- Scheduled tasks: a cron or a one-off time, run as their owner
CREATE TABLE schedules (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  owner_name TEXT,
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  cron TEXT,
  run_at INTEGER,
  timezone TEXT NOT NULL,
  delivery TEXT NOT NULL DEFAULT 'web',
  enabled INTEGER NOT NULL DEFAULT 1,
  next_run_at INTEGER,
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

CREATE INDEX schedules_owner ON schedules (project_id, owner_id);

CREATE TABLE schedule_runs (
  id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  due_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  thread_id TEXT,
  error TEXT,
  finished_at INTEGER NOT NULL
);

CREATE INDEX schedule_runs_schedule ON schedule_runs (schedule_id, finished_at);

-- Project snapshots in object storage (backups/<project>/)
CREATE TABLE backups (
  key TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX backups_project ON backups (project_id, created_at);

CREATE TABLE system_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- System rules (guards), one per name
CREATE TABLE system_guards (
  name TEXT PRIMARY KEY,
  description TEXT NOT NULL DEFAULT '',
  rule TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Own dashboards: a project's, or the system's (project_id NULL)
CREATE TABLE dashboards (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  name TEXT NOT NULL,
  definition TEXT NOT NULL,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX dashboards_project ON dashboards (project_id);
