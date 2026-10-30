import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient, type Client, type InValue } from "@libsql/client";

/**
 * The services' database: a single SQLite file on its volume (`LocalDb`); the same class serves development and tests.
 * Code here never reads and then writes inside one transaction: a batch of statements is applied atomically, and work
 * is claimed with a single conditional UPDATE that stamps a claim token, then read back by that token. Time is always
 * passed in as a parameter (epoch ms), never `datetime('now')`.
 */
export type Value = string | number | null;
export type Statement = { sql: string; args?: Value[] };

export interface Db {
  /** Runs write statements; with `transaction` (default) all of them or none. */
  execute(statements: Statement[], options?: { transaction?: boolean }): Promise<{ rowsAffected: number }[]>;
  /** Reads rows as objects. `fresh` marks a read after a claim; with one file it is the same as any read. */
  query<T = Record<string, Value>>(sql: string, args?: Value[], options?: { fresh?: boolean }): Promise<T[]>;
  close(): Promise<void>;
}

export class DbError extends Error {}

export const run = (sql: string, ...args: Value[]): Statement => ({ sql, args });

/** A local SQLite file: production, development and tests. */
export class LocalDb implements Db {
  private readonly client: Client;

  constructor(path: string) {
    this.client = createClient({ url: `file:${path}` });
  }

  async execute(statements: Statement[], { transaction = true } = {}) {
    const stmts = statements.map((s) => ({ sql: s.sql, args: (s.args ?? []) as InValue[] }));
    try {
      if (transaction) return (await this.client.batch(stmts, "write")).map((r) => ({ rowsAffected: r.rowsAffected }));
      const out = [];
      for (const s of stmts) out.push({ rowsAffected: (await this.client.execute(s)).rowsAffected });
      return out;
    } catch (err) {
      throw new DbError((err as Error).message);
    }
  }

  async query<T>(sql: string, args: Value[] = []) {
    const { rows, columns } = await this.client.execute({ sql, args: args as InValue[] });
    return rows.map((r) => Object.fromEntries(columns.map((c, i) => [c, normalize(r[i])]))) as T[];
  }

  async close() {
    this.client.close();
  }
}

const normalize = (v: unknown): Value => (typeof v === "bigint" ? Number(v) : v instanceof ArrayBuffer ? null : (v as Value));

/**
 * Applies pending `*.sql` files from `dir` in order, each atomically with its `_migrations` row. Statements are split
 * on `;` at line ends. Replicas starting together may race: the loser's batch fails on the `_migrations` key and is
 * rolled back, so it only re-checks.
 */
export async function migrate(db: Db, dir: string): Promise<string[]> {
  await db.execute([run("CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)")]);
  const applied = new Set((await db.query<{ name: string }>("SELECT name FROM _migrations", [], { fresh: true })).map((r) => r.name));
  const done: string[] = [];
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    if (applied.has(name)) continue;
    const statements = readFileSync(join(dir, name), "utf8")
      .split(/;\s*$/m)
      .map((s) => s.replace(/^\s*--.*$/gm, "").trim())
      .filter(Boolean)
      .map((sql) => run(sql));
    try {
      await db.execute([...statements, run("INSERT INTO _migrations (name, applied_at) VALUES (?, ?)", name, Date.now())]);
      done.push(name);
    } catch (err) {
      const now = await db.query("SELECT 1 FROM _migrations WHERE name = ?", [name], { fresh: true });
      if (!now.length) throw err;
    }
  }
  return done;
}
