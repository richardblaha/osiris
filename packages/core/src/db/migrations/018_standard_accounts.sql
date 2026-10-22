CREATE TABLE IF NOT EXISTS standard_accounts (
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  data_enc TEXT NOT NULL,
  PRIMARY KEY(owner, name)
);
