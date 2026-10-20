-- Inquiries customers left with the tenant's public assistant: who, how to reach them, what they want, and the chat
CREATE TABLE inquiries (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  contact TEXT NOT NULL,
  description TEXT NOT NULL,
  preferred_time TEXT,
  thread_id TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX inquiries_status ON inquiries(status, created_at);
