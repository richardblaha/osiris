CREATE TABLE image_jobs (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  call_id TEXT NOT NULL,
  state TEXT NOT NULL,
  request TEXT NOT NULL,
  provider_id TEXT,
  context TEXT,
  result TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(thread_id, user_id, call_id)
);
CREATE INDEX image_jobs_thread ON image_jobs(thread_id, user_id, created_at);
