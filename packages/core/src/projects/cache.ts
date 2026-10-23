import type { Client } from "@libsql/client";

/** Bump when the schema changes: an older cache is thrown away and rebuilt from the files. */
const VERSION = 1;

const SCHEMA = [
  // When each indexed text file was modified, to tell what changed on disk.
  "CREATE TABLE indexed_files (owner TEXT NOT NULL, path TEXT NOT NULL, modified INTEGER NOT NULL, PRIMARY KEY (owner, path))",
  "CREATE VIRTUAL TABLE file_text USING fts5(owner UNINDEXED, path UNINDEXED, content, tokenize = 'unicode61 remove_diacritics 2')",
  // Knowledge documents' chunks with vectors, and their text for full-text search (rowid = the chunk's id).
  "CREATE TABLE knowledge_chunks (id INTEGER PRIMARY KEY, owner TEXT NOT NULL, path TEXT NOT NULL, idx INTEGER NOT NULL, content TEXT NOT NULL, embedding_model TEXT NOT NULL, embedding BLOB NOT NULL)",
  "CREATE INDEX knowledge_chunks_file ON knowledge_chunks(owner, path)",
  "CREATE VIRTUAL TABLE knowledge_text USING fts5(content, tokenize = 'unicode61 remove_diacritics 2')",
  `PRAGMA user_version = ${VERSION}`,
];

/**
 * The project's derived indexes (`.osiris/cache/index.db`): full text of its files and the knowledge base's vectors.
 * Nothing in it is the truth: an outdated cache is emptied here and rebuilt from the files by the indexers at init.
 */
export async function prepareCache(db: Client): Promise<void> {
  if (Number((await db.execute("PRAGMA user_version")).rows[0]?.[0] ?? 0) === VERSION) return;
  const { rows } = await db.execute("SELECT name FROM sqlite_master WHERE type IN ('table') AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_data' AND name NOT LIKE '%_idx' AND name NOT LIKE '%_content' AND name NOT LIKE '%_docsize' AND name NOT LIKE '%_config'");
  await db.batch([...rows.map((r) => `DROP TABLE IF EXISTS "${String(r.name)}"`), ...SCHEMA], "write");
}
