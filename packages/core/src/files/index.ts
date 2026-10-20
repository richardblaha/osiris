import type { Client } from "@libsql/client";

export interface FileHit {
  owner: string;
  path: string;
  /** The matching passage, with matches in «»; not HTML. */
  snippet: string;
}

/** Words of a query as an FTS5 expression: each word as a prefix, all of them (`AND`) or any (`OR`). */
export function ftsQuery(query: string, join: "AND" | "OR" = "AND"): string | null {
  const words = query.match(/[\p{L}\p{N}]+/gu)?.slice(0, 12) ?? [];
  return words.length ? words.map((w) => `"${w}"*`).join(` ${join} `) : null;
}

/** Full-text index of the tenant's text files (tenant-wide and personal); temp files are left out. */
export class FileIndex {
  constructor(private readonly db: Client) {}

  async put(owner: string, path: string, content: string, modified: number) {
    await this.db.batch(
      [
        { sql: "DELETE FROM file_text WHERE owner = ? AND path = ?", args: [owner, path] },
        { sql: "INSERT INTO file_text (owner, path, content) VALUES (?, ?, ?)", args: [owner, path, content] },
        {
          sql: "INSERT INTO indexed_files (owner, path, modified) VALUES (?, ?, ?) ON CONFLICT (owner, path) DO UPDATE SET modified = excluded.modified",
          args: [owner, path, modified],
        },
      ],
      "write",
    );
  }

  /** Drops a file, or everything under a folder. */
  async remove(owner: string, path: string) {
    const under = `${path}/%`;
    await this.db.batch(
      [
        { sql: "DELETE FROM file_text WHERE owner = ? AND (path = ? OR path LIKE ?)", args: [owner, path, under] },
        { sql: "DELETE FROM indexed_files WHERE owner = ? AND (path = ? OR path LIKE ?)", args: [owner, path, under] },
      ],
      "write",
    );
  }

  /** When each indexed file of an owner was modified (ms), to tell what changed on disk. */
  async modified(owner: string): Promise<Map<string, number>> {
    const { rows } = await this.db.execute({ sql: "SELECT path, modified FROM indexed_files WHERE owner = ?", args: [owner] });
    return new Map(rows.map((r) => [String(r.path), Number(r.modified)]));
  }

  async owners(): Promise<string[]> {
    const { rows } = await this.db.execute("SELECT DISTINCT owner FROM indexed_files");
    return rows.map((r) => String(r.owner));
  }

  /** Files of the given owners whose text has all the query's words, best first. */
  async search(query: string, owners: string[], limit = 20): Promise<FileHit[]> {
    const match = ftsQuery(query);
    if (!match || !owners.length) return [];
    const { rows } = await this.db.execute({
      sql: `SELECT owner, path, snippet(file_text, 2, '«', '»', '…', 12) AS snippet FROM file_text
            WHERE file_text MATCH ? AND owner IN (${owners.map(() => "?").join(", ")})
            ORDER BY bm25(file_text) LIMIT ?`,
      args: [match, ...owners, limit],
    });
    return rows.map((r) => ({ owner: String(r.owner), path: String(r.path), snippet: String(r.snippet) }));
  }
}
