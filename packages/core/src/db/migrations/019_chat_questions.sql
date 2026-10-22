CREATE TABLE chat_questions (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  definition TEXT NOT NULL,
  answer TEXT,
  state TEXT NOT NULL DEFAULT 'open',
  expires_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX chat_question_open ON chat_questions(thread_id) WHERE state='open';
