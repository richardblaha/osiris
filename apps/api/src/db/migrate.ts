import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "@libsql/client";

const MIGRATIONS_DIR = join(import.meta.dirname, "migrations");

/** Applies pending `migrations/*.sql` files in filename order, each in its own transaction. */
export async function migrate(db: Client): Promise<string[]> {
  await db.execute(
    "CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))",
  );
  const applied = new Set((await db.execute("SELECT name FROM _migrations")).rows.map((r) => String(r.name)));
  const pending = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql") && !applied.has(f))
    .sort();

  for (const name of pending) {
    // Statements are split on `;` at end of line, so migrations must not contain triggers or other multi-statement bodies.
    const statements = readFileSync(join(MIGRATIONS_DIR, name), "utf8")
      .split(/;\s*$/m)
      .map((s) => s.trim())
      .filter(Boolean);
    await db.batch([...statements, { sql: "INSERT INTO _migrations (name) VALUES (?)", args: [name] }], "write");
  }
  return pending;
}
