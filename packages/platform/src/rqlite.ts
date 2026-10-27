import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient, type Client, type InValue } from "@libsql/client";

/**
 * Control's database is a single SQLite file on its volume (`LocalDb`); the same class serves development and tests.
 * rqlite has no interactive transactions, so code here never reads and then writes inside one: a batch of statements
 * is applied atomically, and work is claimed with a single conditional UPDATE that stamps a claim token, then read
 * back by that token. Time is always passed in as a parameter (epoch ms), never `datetime('now')`, so every node
 * computes the same.
 */
export type Value = string | number | null;
export type Statement = { sql: string; args?: Value[] };

export interface Db {
  /** Runs write statements; with `transaction` (default) all of them or none. */
  execute(statements: Statement[], options?: { transaction?: boolean }): Promise<{ rowsAffected: number }[]>;
  /** Reads rows as objects. `fresh` reads from the leader with linearizable consistency (after a claim). */
  query<T = Record<string, Value>>(sql: string, args?: Value[], options?: { fresh?: boolean }): Promise<T[]>;
  close(): Promise<void>;
}

export class DbError extends Error {}

export const run = (sql: string, ...args: Value[]): Statement => ({ sql, args });

interface RqliteResult {
  rows_affected?: number;
  rows?: Record<string, Value>[];
  error?: string;
}

/** rqlite over its HTTP API. Any node accepts the call and forwards writes to the leader. */
export class RqliteDb implements Db {
  private readonly base: string;
  private readonly auth?: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(url: string, options: { username?: string; password?: string; fetchFn?: typeof fetch; timeoutMs?: number } = {}) {
    this.base = url.replace(/\/$/, "");
    this.fetchFn = options.fetchFn ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    if (options.username) this.auth = `Basic ${Buffer.from(`${options.username}:${options.password ?? ""}`).toString("base64")}`;
  }

  private async post(path: string, body: unknown): Promise<RqliteResult[]> {
    const res = await this.fetchFn(`${this.base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(this.auth ? { authorization: this.auth } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new DbError(`rqlite ${path.split("?")[0]} failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
    const json = (await res.json()) as { results?: RqliteResult[]; error?: string };
    if (json.error) throw new DbError(`rqlite: ${json.error}`);
    const failed = json.results?.find((r) => r.error);
    if (failed) throw new DbError(`rqlite: ${failed.error}`);
    return json.results ?? [];
  }

  async execute(statements: Statement[], { transaction = true } = {}) {
    if (!statements.length) return [];
    const results = await this.post(`/db/execute${transaction ? "?transaction" : ""}`, statements.map((s) => [s.sql, ...(s.args ?? [])]));
    return results.map((r) => ({ rowsAffected: r.rows_affected ?? 0 }));
  }

  async query<T>(sql: string, args: Value[] = [], { fresh = false } = {}) {
    const level = fresh ? "linearizable" : "weak";
    const [result] = await this.post(`/db/query?associative&level=${level}`, [[sql, ...args]]);
    return (result?.rows ?? []) as T[];
  }

  async close() {}
}

/** A local SQLite file with the same semantics: development and tests. */
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
