-- WhatsApp conversation of each user in this tenant. A user in several tenants switches with the `/firma` command, and
-- the tenant chosen most recently (`selected_at`, epoch ms) is the active one. `thread_id` NULL = start a new thread.
CREATE TABLE whatsapp_sessions (
  user_id TEXT PRIMARY KEY,
  thread_id TEXT,
  selected_at INTEGER
);
