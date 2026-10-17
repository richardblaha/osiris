-- Runs started by control (scheduled tasks, WhatsApp messages) with their result, so a request repeated after a lost
-- lease or a redelivery gets the stored answer instead of running the agent again
CREATE TABLE processed_runs (
  key TEXT PRIMARY KEY,
  thread_id TEXT,
  reply TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
