-- A project may have several public assistants, each with its own knowledge, memories, skills and tools (config JSON).
-- The old single one (project_settings public_assistant) moves here at the project's init
CREATE TABLE public_assistants (
  name TEXT PRIMARY KEY,
  config TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
ALTER TABLE inquiries ADD COLUMN assistant TEXT;
