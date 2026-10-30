-- osiris-auth: users, their sign-in methods, groups (access) and the OpenID Connect provider's state.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  -- Lowercase, unique among users that have one
  email TEXT,
  email_verified INTEGER NOT NULL DEFAULT 0,
  first_name TEXT NOT NULL DEFAULT '',
  last_name TEXT NOT NULL DEFAULT '',
  -- E.164, verified over WhatsApp by control
  phone TEXT,
  disabled INTEGER NOT NULL DEFAULT 0,
  -- Random part of the picture's URL, new with every picture; NULL = no picture
  picture TEXT,
  -- argon2id PHC string; NULL = no password
  password_hash TEXT,
  -- TOTP secret sealed with the auth key; totp_pending until the user confirms it with a code
  totp_secret TEXT,
  totp_pending TEXT,
  -- Last accepted TOTP time step, so a code works only once
  totp_step INTEGER NOT NULL DEFAULT 0,
  last_login_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX users_email ON users (email) WHERE email IS NOT NULL;

-- Groups grant access: osiris-user, osiris-admin, project:<slug>, project-admin:<slug>
CREATE TABLE groups (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
CREATE TABLE group_members (
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX group_members_user ON group_members (user_id);

-- Bearer tokens of other services for the SCIM API (SHA-256 of the token)
CREATE TABLE service_tokens (
  token_hash TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

-- One-time codes for when the second factor is lost (SHA-256 of the normalized code)
CREATE TABLE recovery_codes (
  user_id TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  PRIMARY KEY (user_id, code_hash)
);

-- WebAuthn credentials; id and public key base64url
CREATE TABLE passkeys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT NOT NULL DEFAULT '[]',
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX passkeys_user ON passkeys (user_id);

-- Accounts at Google, Facebook, Microsoft and Seznam linked to a user, at most one per provider
CREATE TABLE user_identities (
  provider TEXT NOT NULL,
  subject TEXT NOT NULL,
  user_id TEXT NOT NULL,
  email TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (provider, subject)
);
CREATE UNIQUE INDEX user_identities_user ON user_identities (user_id, provider);

-- One-time sign-in links: invitations, links an admin passes on, links sent by email (SHA-256 of the token)
CREATE TABLE login_links (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  -- invite | admin | email
  purpose TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX login_links_expires ON login_links (expires_at);

-- Short-lived steps of a sign-in, each taken once: WebAuthn challenges, a pending second factor, social login state
CREATE TABLE auth_challenges (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX auth_challenges_expires ON auth_challenges (expires_at);

-- The OpenID Connect provider's models (sessions, interactions, grants, codes, tokens) as oidc-provider stores them
CREATE TABLE oidc_store (
  model TEXT NOT NULL,
  id TEXT NOT NULL,
  payload TEXT NOT NULL,
  grant_id TEXT,
  uid TEXT,
  user_code TEXT,
  -- epoch ms; NULL = no expiry
  expires_at INTEGER,
  PRIMARY KEY (model, id)
);
CREATE INDEX oidc_store_grant ON oidc_store (grant_id);
CREATE INDEX oidc_store_uid ON oidc_store (model, uid);
CREATE INDEX oidc_store_expires ON oidc_store (expires_at);

-- Sign-in audit, kept 90 days, shown only to the user
CREATE TABLE auth_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  at INTEGER NOT NULL,
  success INTEGER NOT NULL,
  method TEXT NOT NULL,
  ip TEXT NOT NULL,
  location TEXT NOT NULL
);
CREATE INDEX auth_events_user_time ON auth_events(user_id, at);
CREATE TABLE auth_session_info (
  uid TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_seen_at INTEGER NOT NULL,
  ip TEXT NOT NULL,
  location TEXT NOT NULL
);
CREATE TABLE auth_session_revocations (
  uid TEXT PRIMARY KEY,
  at INTEGER NOT NULL
);
