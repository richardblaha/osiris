-- Text files of the project (owner '' = project-wide, a sub = that user's), indexed for full-text search and kept in
-- step with the files by the file store's changes (and a check at startup)
CREATE TABLE indexed_files (
  owner TEXT NOT NULL,
  path TEXT NOT NULL,
  modified INTEGER NOT NULL,
  PRIMARY KEY (owner, path)
);
CREATE VIRTUAL TABLE file_text USING fts5(owner UNINDEXED, path UNINDEXED, content, tokenize = 'unicode61 remove_diacritics 2');

-- The knowledge base is the files in knowledge/: their chunks with vectors, plus the chunks' text for full-text search
-- (rowid = the chunk's id). Replaces documents and chunks, whose content moves to files at startup
CREATE TABLE knowledge_chunks (
  id INTEGER PRIMARY KEY,
  owner TEXT NOT NULL,
  path TEXT NOT NULL,
  idx INTEGER NOT NULL,
  content TEXT NOT NULL,
  embedding_model TEXT NOT NULL,
  embedding BLOB NOT NULL
);
CREATE INDEX knowledge_chunks_file ON knowledge_chunks(owner, path);
CREATE VIRTUAL TABLE knowledge_text USING fts5(content, tokenize = 'unicode61 remove_diacritics 2');
