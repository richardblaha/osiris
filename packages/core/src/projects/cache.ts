import type { Client } from "@libsql/client";

/** Bump when the schema changes: an older cache is thrown away and rebuilt from the files. */
const VERSION = 2;

const SCHEMA = [
  // When each indexed text file was modified, to tell what changed on disk.
  "CREATE TABLE indexed_files (owner TEXT NOT NULL, path TEXT NOT NULL, modified INTEGER NOT NULL, PRIMARY KEY (owner, path))",
  "CREATE VIRTUAL TABLE file_text USING fts5(owner UNINDEXED, path UNINDEXED, content, tokenize = 'unicode61 remove_diacritics 2')",
  // Mem0's points (memories, their entities, knowledge chunks) with vectors, and their text for keyword search
  // (rowid = the point's rowid). Memories and entities are files; this is their index.
  "CREATE TABLE mem0_points (collection TEXT NOT NULL, id TEXT NOT NULL, file TEXT, payload TEXT NOT NULL, vector BLOB NOT NULL, PRIMARY KEY (collection, id))",
  "CREATE VIRTUAL TABLE mem0_text USING fts5(content, tokenize = 'unicode61 remove_diacritics 2')",
  `PRAGMA user_version = ${VERSION}`,
];

/**
 * The project's derived indexes (`.osiris/cache/index.db`): full text of its files, and Mem0's vectors of memories and
 * knowledge.
 * Nothing in it is the truth: an outdated cache is emptied here and rebuilt from the files by the indexers at init.
 */
export async function prepareCache(db: Client): Promise<void> {
  if (Number((await db.execute("PRAGMA user_version")).rows[0]?.[0] ?? 0) === VERSION) return;
  const { rows } = await db.execute("SELECT name FROM sqlite_master WHERE type IN ('table') AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_data' AND name NOT LIKE '%_idx' AND name NOT LIKE '%_content' AND name NOT LIKE '%_docsize' AND name NOT LIKE '%_config'");
  await db.batch([...rows.map((r) => `DROP TABLE IF EXISTS "${String(r.name)}"`), ...SCHEMA], "write");
}
