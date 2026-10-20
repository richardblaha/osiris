-- A user's accounts at Google or Microsoft the assistant may use (mail, contacts, calendar): the tokens and a pending
-- sign-in's PKCE verifier (sealed), the account's address, and the sign-in's state value while the user is away
CREATE TABLE integrations (
  owner TEXT NOT NULL,
  provider TEXT NOT NULL,
  account TEXT,
  data_enc TEXT NOT NULL,
  state TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (owner, provider)
);
CREATE UNIQUE INDEX integrations_state ON integrations(state);
