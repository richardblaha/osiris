ALTER TABLE image_jobs ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE image_jobs ADD COLUMN refinements INTEGER NOT NULL DEFAULT 0;
ALTER TABLE image_jobs ADD COLUMN estimated_cost REAL NOT NULL DEFAULT 0;
ALTER TABLE image_jobs ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE image_jobs ADD COLUMN lease_token TEXT;
ALTER TABLE image_jobs ADD COLUMN lease_until INTEGER NOT NULL DEFAULT 0;
CREATE TABLE image_catalog (
  provider TEXT NOT NULL,
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  metadata TEXT NOT NULL,
  verified_at INTEGER NOT NULL,
  PRIMARY KEY(provider, kind, id)
);
CREATE TABLE image_selections (
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  revision_id TEXT NOT NULL REFERENCES image_jobs(id) ON DELETE CASCADE,
  selected_index INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(thread_id, user_id)
);
