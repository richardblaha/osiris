-- Sign-in moves from PocketID to control: users, their sign-in methods and the OpenID Connect provider's state.
-- `pnpm --filter @osiris/control users import-pocketid` copies the PocketID users over with their ids

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  -- Lowercase, unique among users that have one
  email TEXT,
  email_verified INTEGER NOT NULL DEFAULT 0,
  first_name TEXT NOT NULL DEFAULT '',
  last_name TEXT NOT NULL DEFAULT '',
  -- JSON object of the claims that grant access and identify the user: role, tenant, tenant-admin, phone_number
  claims TEXT NOT NULL DEFAULT '{}',
  -- Bumped with every claims change, so two changes at once can't overwrite each other
  claims_version INTEGER NOT NULL DEFAULT 0,
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
