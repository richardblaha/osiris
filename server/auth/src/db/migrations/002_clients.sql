-- Applications that sign users in (OpenID Connect clients), registered by admins
CREATE TABLE clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  -- URL of the app's logo, shown on the sign-in page; NULL = none
  logo TEXT,
  -- JSON: redirect_uris, post_logout_redirect_uris, application_type (web | native), confidential (true = has a secret)
  metadata TEXT NOT NULL,
  -- The client secret sealed with a key derived from AUTH_SECRET; NULL for public clients (PKCE only)
  secret TEXT,
  -- JSON list of groups whose members may sign in to it; empty = everyone
  allowed_groups TEXT NOT NULL DEFAULT '[]',
  -- JSON list of client ids whose access tokens this client may introspect (a resource server); empty = none
  accepts_tokens_of TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- The identity provider's own administrators: whoever administered Osiris
INSERT INTO groups (id, display_name, created_at) SELECT 'admin', 'admin', 0 WHERE EXISTS (SELECT 1 FROM group_members WHERE group_id = 'osiris-admin') ON CONFLICT DO NOTHING;
INSERT INTO group_members (group_id, user_id) SELECT 'admin', user_id FROM group_members WHERE group_id = 'osiris-admin' ON CONFLICT DO NOTHING;
