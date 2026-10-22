import { fork } from "node:child_process";
import { stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { Client, InValue } from "@libsql/client";
import { DB_COLUMN_TYPES, type DbColumn, type DbColumnType, type DbQueryResult, type DbRows, type DbTable } from "@osiris/shared";

export type DataErrorCode = "invalid" | "not_found" | "exists" | "quota";

/** A refused request, its message for the user (Czech). */
export class DataError extends Error {
  constructor(
    message: string,
    readonly code: DataErrorCode,
  ) {
    super(message);
  }
}

export interface ColumnInput {
  name: string;
  type: DbColumnType;
  required?: boolean;
  unique?: boolean;
  /** A table whose row `id` the column holds (type integer). */
  references?: string | null;
}

/** Rows matched by equality on every key (AND): a value, null (IS NULL) or a list (IN). */
export type Where = Record<string, string | number | boolean | null | (string | number)[]>;

export interface TableChange {
  description?: string;
  rename?: string;
  addColumns?: ColumnInput[];
  renameColumns?: { from: string; to: string }[];
  dropColumns?: string[];
}

export interface DataLimits {
  tables: number | null;
  bytes: number | null;
}

const NAME = /^[a-z][a-z0-9_]{0,62}$/;
const SYSTEM_COLUMNS = ["id", "created_at", "updated_at"];
const META = "_tables";
export const MAX_COLUMNS = 100;
export const MAX_ROWS_PER_WRITE = 100;
export const MAX_PAGE = 500;
export const QUERY_ROWS = 200;
const MAX_TEXT = 100_000;
const QUERY_TIMEOUT_MS = 5_000;

const DECLARED: Record<DbColumnType, string> = { text: "TEXT", integer: "INTEGER", real: "REAL", boolean: "BOOLEAN", date: "DATE", datetime: "DATETIME", json: "JSON" };
const typeOf = (declared: string): DbColumnType =>
  (DB_COLUMN_TYPES.find((t) => DECLARED[t] === declared.toUpperCase()) ?? "text");
/** Names are checked against NAME before they get here. */
const q = (name: string) => `"${name}"`;

const LIBSQL = createRequire(import.meta.url).resolve("@libsql/client");
const QUERY_PROCESS = fileURLToPath(new URL("./query-process.cjs", import.meta.url));
/** Strings, quoted names and comments, which may hold anything. */
const LITERALS = /--[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^']|'')*'|"(?:[^"]|"")*"|`[^`]*`|\[[^\]]*\]/g;
const FORBIDDEN = /\b(attach|detach|pragma|vacuum|load_extension)\b/i;

/**
 * Checks a query is one SELECT (or WITH/VALUES) and returns it without trailing semicolons. The query runs on a
 * `query_only` connection, which refuses writes; ATTACH (which query_only allows, and which would reach the tenant's
 * own database) and PRAGMA are refused here.
 */
export function readOnlySql(sql: string): string {
  const bare = sql.replace(LITERALS, (m) => " ".repeat(m.length));
  if (/['"`]|\/\*/.test(bare)) throw new DataError("Dotaz má neukončený řetězec nebo komentář.", "invalid");
  const end = bare.search(/;[\s;]*$/);
  const body = end >= 0 ? bare.slice(0, end) : bare;
  if (body.includes(";")) throw new DataError("Pošli jen jeden příkaz.", "invalid");
  if (!/^\s*(select|with|values)\b/i.test(body)) throw new DataError("Dotaz musí být SELECT (data se mění nástroji pro zápis).", "invalid");
  const bad = FORBIDDEN.exec(body);
  if (bad) throw new DataError(`${bad[1]!.toUpperCase()} v dotazu není dovolený.`, "invalid");
  return sql.slice(0, end >= 0 ? end : sql.length);
}

function checkName(name: string, what: string) {
  if (!NAME.test(name)) throw new DataError(`Neplatný název ${what} „${name}“: malá písmena bez diakritiky, číslice a _, na začátku písmeno.`, "invalid");
}

/** A value for a column, as SQLite stores it; null for none (refused when the column is required). */
function encode(col: DbColumn, v: unknown): InValue {
  const bad = (expected: string) => new DataError(`Sloupec ${col.name} čeká ${expected}, dostal ${JSON.stringify(v)?.slice(0, 80)}.`, "invalid");
  if (v === null || v === undefined || v === "") {
    if (col.required) throw new DataError(`Sloupec ${col.name} je povinný.`, "invalid");
    return null;
  }
  switch (col.type) {
    case "text": {
      if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") throw bad("text");
      const s = String(v);
      if (s.length > MAX_TEXT) throw new DataError(`Text ve sloupci ${col.name} je delší než ${MAX_TEXT} znaků.`, "invalid");
      return s;
    }
    case "integer":
    case "real": {
      const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v.trim().replace(",", ".")) : NaN;
      if (col.type === "integer" ? !Number.isSafeInteger(n) : !Number.isFinite(n)) throw bad(col.type === "integer" ? "celé číslo" : "číslo");
      return n;
    }
    case "boolean":
      if (v === true || v === 1 || v === "true") return 1;
      if (v === false || v === 0 || v === "false") return 0;
      throw bad("true nebo false");
    case "date":
      if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) throw bad("datum RRRR-MM-DD");
      return v;
    case "datetime":
      if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(v) || Number.isNaN(Date.parse(v))) throw bad("datum a čas ISO 8601");
      return v.replace(" ", "T");
    case "json": {
      if (typeof v === "string") {
        try {
          JSON.parse(v);
          return v;
        } catch {
          return JSON.stringify(v);
        }
      }
      return JSON.stringify(v);
    }
  }
}

function decode(col: DbColumn, v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (col.type === "boolean") return v === 1 || v === 1n || v === true;
  if (col.type === "json" && typeof v === "string") {
    try {
      return JSON.parse(v) as unknown;
    } catch {
      return v;
    }
  }
  return typeof v === "bigint" ? Number(v) : v;
}

/** SQLite's constraint errors in words the user understands. */
function friendly(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err);
  const unique = /UNIQUE constraint failed: \w+\.(\w+)/.exec(message);
  if (unique) throw new DataError(`Hodnota ve sloupci ${unique[1]} už v tabulce je (musí být jedinečná).`, "invalid");
  if (/FOREIGN KEY constraint failed/.test(message)) {
    throw new DataError("Odkaz nesedí: odkazovaný záznam neexistuje, nebo na mazaný záznam odkazují jiné.", "invalid");
  }
  const notNull = /NOT NULL constraint failed: \w+\.(\w+)/.exec(message);
  if (notNull) throw new DataError(`Sloupec ${notNull[1]} je povinný.`, "invalid");
  if (/SQLITE_ERROR|SQLITE_CONSTRAINT/.test(message)) throw new DataError(message.replace(/^SQLITE_\w+: /, ""), "invalid");
  throw err;
}

/**
 * The tenant's own database for the assistant's data (contacts, deals…): its own file next to the tenant's database,
 * so nothing here reaches the tenant's settings, conversations or secrets. Tables get `id`, `created_at` and
 * `updated_at`; everything else is defined by the assistant or an admin. Writes are structured (no SQL from outside),
 * free-form SQL is read-only and runs in a process of its own (`query`).
 */
export class DataStore {
  private ready?: Promise<void>;

  constructor(
    /** Its own connection, for the snapshot's copy. */
    readonly db: Client,
    /** The database file, for its size and for the query process. */
    private readonly path: string,
    private readonly limits: () => Promise<DataLimits> = async () => ({ tables: null, bytes: null }),
  ) {}

  /** The meta table and foreign keys, once per connection (the store never opens transactions, which would swap it). */
  private init() {
    return (this.ready ??= (async () => {
      await this.db.execute("PRAGMA foreign_keys = ON");
      await this.db.execute(`CREATE TABLE IF NOT EXISTS ${META} (name TEXT PRIMARY KEY, description TEXT NOT NULL DEFAULT '')`);
    })().catch((err) => {
      this.ready = undefined;
      throw err;
    }));
  }

  /** The file's size in bytes, with its write-ahead log. */
  async size(): Promise<number> {
    const bytes = async (p: string) => (await stat(p).catch(() => null))?.size ?? 0;
    return (await bytes(this.path)) + (await bytes(`${this.path}-wal`));
  }

  async tables(): Promise<DbTable[]> {
    await this.init();
    return Promise.all((await this.names()).map((n) => this.describe(n)));
  }

  /** How many tables there are (the quota), without describing them. */
  async tableCount(): Promise<number> {
    await this.init();
    return (await this.names()).length;
  }

  async table(name: string): Promise<DbTable> {
    await this.init();
    if (!(await this.names()).includes(name)) throw new DataError(`Tabulka ${name} neexistuje.`, "not_found");
    return this.describe(name);
  }

  async createTable(name: string, description: string, columns: ColumnInput[]): Promise<DbTable> {
    await this.init();
    checkName(name, "tabulky");
    const names = await this.names();
    if (names.includes(name)) throw new DataError(`Tabulka ${name} už existuje.`, "exists");
    const { tables } = await this.limits();
    if (tables !== null && names.length >= tables) throw new DataError(`Firma může mít nejvýš ${tables} tabulek.`, "quota");
    await this.checkRoom();
    if (!columns.length || columns.length > MAX_COLUMNS) throw new DataError(`Tabulka potřebuje 1 až ${MAX_COLUMNS} sloupců.`, "invalid");
    const seen = new Set<string>();
    for (const c of columns) {
      this.checkColumn(c, [...names, name]);
      if (seen.has(c.name)) throw new DataError(`Sloupec ${c.name} je tam dvakrát.`, "invalid");
      seen.add(c.name);
    }
    const defs = columns.map((c) => `${q(c.name)} ${DECLARED[c.type]}${c.required ? " NOT NULL" : ""}${this.reference(c)}`);
    await this.db
      .execute(`CREATE TABLE ${q(name)} ("id" INTEGER PRIMARY KEY, ${defs.join(", ")}, "created_at" DATETIME NOT NULL, "updated_at" DATETIME NOT NULL)`)
      .catch(friendly);
    for (const c of columns.filter((c) => c.unique)) await this.addUnique(name, c.name);
    await this.setDescription(name, description);
    return this.describe(name);
  }

  async alterTable(name: string, change: TableChange): Promise<DbTable> {
    let table = await this.table(name);
    const has = (c: string) => table.columns.some((x) => x.name === c);
    const user = (c: string) => {
      if (SYSTEM_COLUMNS.includes(c)) throw new DataError(`Sloupec ${c} patří každé tabulce, ten měnit nejde.`, "invalid");
      if (!has(c)) throw new DataError(`Sloupec ${c} v tabulce ${name} není.`, "not_found");
    };
    for (const c of change.dropColumns ?? []) {
      user(c);
      for (const index of await this.uniqueIndexes(name, c)) await this.db.execute(`DROP INDEX ${q(index)}`);
      await this.db.execute(`ALTER TABLE ${q(name)} DROP COLUMN ${q(c)}`).catch(friendly);
    }
    for (const { from, to } of change.renameColumns ?? []) {
      user(from);
      checkName(to, "sloupce");
      if (SYSTEM_COLUMNS.includes(to) || has(to)) throw new DataError(`Sloupec ${to} už v tabulce je.`, "exists");
      await this.db.execute(`ALTER TABLE ${q(name)} RENAME COLUMN ${q(from)} TO ${q(to)}`).catch(friendly);
      table = await this.describe(name);
    }
    if (change.addColumns?.length) {
      await this.checkRoom();
      if (table.columns.length + change.addColumns.length > MAX_COLUMNS + SYSTEM_COLUMNS.length) {
        throw new DataError(`Tabulka může mít nejvýš ${MAX_COLUMNS} sloupců.`, "invalid");
      }
      const names = await this.names();
      for (const c of change.addColumns) {
        this.checkColumn(c, names);
        if (has(c.name)) throw new DataError(`Sloupec ${c.name} už v tabulce je.`, "exists");
        // SQLite adds a NOT NULL column only with a default, which a new column of existing rows has none of.
        if (c.required) throw new DataError(`Nový sloupec ${c.name} nemůže být povinný (stávající řádky ho nemají).`, "invalid");
        await this.db.execute(`ALTER TABLE ${q(name)} ADD COLUMN ${q(c.name)} ${DECLARED[c.type]}${this.reference(c)}`).catch(friendly);
        if (c.unique) await this.addUnique(name, c.name);
        table = await this.describe(name);
      }
    }
    if (change.rename && change.rename !== name) {
      checkName(change.rename, "tabulky");
      if ((await this.names()).includes(change.rename)) throw new DataError(`Tabulka ${change.rename} už existuje.`, "exists");
      await this.db.execute(`ALTER TABLE ${q(name)} RENAME TO ${q(change.rename)}`).catch(friendly);
      await this.db.execute({ sql: `UPDATE ${META} SET name = ? WHERE name = ?`, args: [change.rename, name] });
      name = change.rename;
    }
    if (change.description !== undefined) await this.setDescription(name, change.description);
    return this.describe(name);
  }

  async dropTable(name: string): Promise<void> {
    await this.table(name);
    await this.db.execute(`DROP TABLE ${q(name)}`).catch(friendly);
    await this.db.execute({ sql: `DELETE FROM ${META} WHERE name = ?`, args: [name] });
  }

  /** Adds rows in one statement (all or none); answers their ids. */
  async insert(name: string, rows: Record<string, unknown>[]): Promise<number[]> {
    const table = await this.table(name);
    if (!rows.length || rows.length > MAX_ROWS_PER_WRITE) throw new DataError(`Najednou jde vložit 1 až ${MAX_ROWS_PER_WRITE} řádků.`, "invalid");
    await this.checkRoom();
    const columns = table.columns.filter((c) => !c.system);
    for (const row of rows) this.checkKeys(table, row);
    const now = new Date().toISOString();
    const args = rows.flatMap((row) => [...columns.map((c) => encode(c, row[c.name])), now, now]);
    const marks = `(${[...columns, 0, 0].map(() => "?").join(", ")})`;
    const { rows: ids } = await this.db
      .execute({
        sql: `INSERT INTO ${q(name)} (${[...columns.map((c) => q(c.name)), '"created_at"', '"updated_at"'].join(", ")}) VALUES ${rows.map(() => marks).join(", ")} RETURNING id`,
        args,
      })
      .catch(friendly);
    return ids.map((r) => Number(r.id));
  }

  /** Changes the given columns of the matching rows; answers how many. */
  async update(name: string, where: Where, values: Record<string, unknown>): Promise<number> {
    const table = await this.table(name);
    this.checkKeys(table, values);
    const set = Object.keys(values);
    if (!set.length) throw new DataError("Není co měnit.", "invalid");
    await this.checkRoom();
    const col = (n: string) => table.columns.find((c) => c.name === n)!;
    const filter = this.where(table, where);
    const r = await this.db
      .execute({
        sql: `UPDATE ${q(name)} SET ${[...set.map((n) => `${q(n)} = ?`), '"updated_at" = ?'].join(", ")} WHERE ${filter.sql}`,
        args: [...set.map((n) => encode(col(n), values[n])), new Date().toISOString(), ...filter.args],
      })
      .catch(friendly);
    return r.rowsAffected;
  }

  async delete(name: string, where: Where): Promise<number> {
    const table = await this.table(name);
    const filter = this.where(table, where);
    const r = await this.db.execute({ sql: `DELETE FROM ${q(name)} WHERE ${filter.sql}`, args: filter.args }).catch(friendly);
    return r.rowsAffected;
  }

  /** A page of a table for the browser: ordered by a column, optionally only rows with the text in a text column. */
  async rows(name: string, opts: { limit?: number; offset?: number; order?: string; desc?: boolean; search?: string } = {}): Promise<DbRows> {
    const table = await this.table(name);
    const order = opts.order && table.columns.some((c) => c.name === opts.order) ? opts.order : "id";
    const texts = table.columns.filter((c) => c.type === "text" || c.type === "json");
    const term = opts.search?.trim();
    const like = term && texts.length ? `WHERE ${texts.map((c) => `${q(c.name)} LIKE ? ESCAPE '\\'`).join(" OR ")}` : "";
    const args = like ? texts.map(() => `%${term!.replace(/[\\%_]/g, (m) => `\\${m}`)}%`) : [];
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), MAX_PAGE);
    const [page, count] = await Promise.all([
      this.db.execute({
        sql: `SELECT * FROM ${q(name)} ${like} ORDER BY ${q(order)} ${opts.desc ? "DESC" : "ASC"} LIMIT ? OFFSET ?`,
        args: [...args, limit, Math.max(opts.offset ?? 0, 0)],
      }),
      this.db.execute({ sql: `SELECT COUNT(*) AS n FROM ${q(name)} ${like}`, args }),
    ]);
    return {
      table,
      rows: page.rows.map((r) => Object.fromEntries(table.columns.map((c) => [c.name, decode(c, r[c.name])]))),
      total: Number(count.rows[0]?.n ?? 0),
    };
  }

  /**
   * A read-only query (one SELECT) in a process of its own, killed after QUERY_TIMEOUT_MS: SQLite can't be stopped
   * from JavaScript, so a runaway query would otherwise hold the runtime. At most `limit` rows come back.
   */
  async query(sql: string, limit = QUERY_ROWS): Promise<DbQueryResult> {
    const stmt = readOnlySql(sql);
    await this.init();
    // ponytail: a process per query (~100 ms), no pool or concurrency cap; add one if the console gets busy.
    const result = await new Promise<{ columns: string[]; rows: unknown[][] } | { error: string }>((resolve) => {
      const child = fork(QUERY_PROCESS, [], { execArgv: [], env: { OSIRIS_LIBSQL: LIBSQL }, serialization: "advanced", stdio: ["ignore", "ignore", "pipe", "ipc"] });
      let stderr = "";
      child.stderr?.on("data", (d: Buffer) => (stderr = (stderr + d.toString()).slice(-500)));
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve({ error: `Dotaz trval déle než ${QUERY_TIMEOUT_MS / 1000} s. Zjednoduš ho nebo omez počet řádků.` });
      }, QUERY_TIMEOUT_MS);
      child.once("message", (m) => (clearTimeout(timer), child.kill("SIGKILL"), resolve(m as { columns: string[]; rows: unknown[][] })));
      child.once("exit", () => (clearTimeout(timer), resolve({ error: stderr.trim() || "Dotaz se nepodařilo spustit." })));
      child.send({ url: `file:${this.path}`, sql: `SELECT * FROM (\n${stmt}\n) LIMIT ${limit + 1}` });
    });
    if ("error" in result) throw new DataError(result.error.replace(/^SQLITE_\w+: /, ""), "invalid");
    return { columns: result.columns, rows: result.rows.slice(0, limit), truncated: result.rows.length > limit };
  }

  private async names(): Promise<string[]> {
    const { rows } = await this.db.execute(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name <> '${META}' ORDER BY name`,
    );
    return rows.map((r) => String(r.name));
  }

  private async describe(name: string): Promise<DbTable> {
    const [info, refs, uniques, count, meta] = await Promise.all([
      this.db.execute({ sql: "SELECT name, type, \"notnull\" AS required FROM pragma_table_info(?) ORDER BY cid", args: [name] }),
      this.db.execute({ sql: 'SELECT "from", "table" FROM pragma_foreign_key_list(?)', args: [name] }),
      this.uniqueIndexes(name),
      this.db.execute(`SELECT COUNT(*) AS n FROM ${q(name)}`),
      this.db.execute({ sql: `SELECT description FROM ${META} WHERE name = ?`, args: [name] }),
    ]);
    const unique = new Set(uniques.map((u) => u.column));
    return {
      name,
      description: String(meta.rows[0]?.description ?? ""),
      rows: Number(count.rows[0]?.n ?? 0),
      columns: info.rows.map((r) => {
        const column = String(r.name);
        const system = SYSTEM_COLUMNS.includes(column);
        return {
          name: column,
          type: column === "id" ? "integer" : typeOf(String(r.type)),
          required: system || Number(r.required) === 1,
          unique: column === "id" || unique.has(column),
          references: (refs.rows.find((f) => f.from === column)?.table as string | undefined) ?? null,
          ...(system ? { system: true } : {}),
        } satisfies DbColumn;
      }),
    };
  }

  /** Single-column unique indexes of a table (of one column, when given). */
  private async uniqueIndexes(table: string): Promise<{ index: string; column: string }[]>;
  private async uniqueIndexes(table: string, column: string): Promise<string[]>;
  private async uniqueIndexes(table: string, column?: string) {
    const { rows } = await this.db.execute({
      sql: `SELECT il.name AS idx, (SELECT ii.name FROM pragma_index_info(il.name) ii) AS col
            FROM pragma_index_list(?) il WHERE il."unique" = 1 AND (SELECT COUNT(*) FROM pragma_index_info(il.name)) = 1`,
      args: [table],
    });
    const all = rows.map((r) => ({ index: String(r.idx), column: String(r.col) }));
    return column === undefined ? all : all.filter((u) => u.column === column).map((u) => u.index);
  }

  private async addUnique(table: string, column: string) {
    const index = `${table}__${column}__unique`.slice(0, 120);
    await this.db.execute(`CREATE UNIQUE INDEX ${q(index)} ON ${q(table)} (${q(column)})`).catch((err: unknown) => {
      if (/UNIQUE constraint failed/.test(String(err))) throw new DataError(`Sloupec ${column} nejde nastavit jako jedinečný, hodnoty se opakují.`, "invalid");
      friendly(err);
    });
  }

  private reference(c: ColumnInput) {
    return c.references ? ` REFERENCES ${q(c.references)}("id") ON DELETE ${c.required ? "RESTRICT" : "SET NULL"}` : "";
  }

  private checkColumn(c: ColumnInput, tables: string[]) {
    checkName(c.name, "sloupce");
    if (SYSTEM_COLUMNS.includes(c.name)) throw new DataError(`Sloupec ${c.name} má každá tabulka sama, nepřidávej ho.`, "invalid");
    if (!DB_COLUMN_TYPES.includes(c.type)) throw new DataError(`Neznámý typ ${c.type}; povolené: ${DB_COLUMN_TYPES.join(", ")}.`, "invalid");
    if (c.references) {
      if (!tables.includes(c.references)) throw new DataError(`Odkazovaná tabulka ${c.references} neexistuje.`, "not_found");
      if (c.type !== "integer") throw new DataError(`Sloupec ${c.name} odkazuje na tabulku, musí být typu integer.`, "invalid");
    }
  }

  private checkKeys(table: DbTable, row: Record<string, unknown>) {
    if (typeof row !== "object" || row === null || Array.isArray(row)) throw new DataError("Řádek musí být objekt sloupec → hodnota.", "invalid");
    for (const key of Object.keys(row)) {
      const col = table.columns.find((c) => c.name === key);
      if (!col) throw new DataError(`Sloupec ${key} v tabulce ${table.name} není (sloupce: ${table.columns.map((c) => c.name).join(", ")}).`, "invalid");
      if (col.system) throw new DataError(`Sloupec ${key} se vyplňuje sám.`, "invalid");
    }
  }

  private where(table: DbTable, where: Where): { sql: string; args: InValue[] } {
    const keys = Object.keys(where ?? {});
    if (!keys.length) throw new DataError("Chybí podmínka where (aspoň jeden sloupec, např. id).", "invalid");
    const parts: string[] = [];
    const args: InValue[] = [];
    for (const key of keys) {
      const col = table.columns.find((c) => c.name === key);
      if (!col) throw new DataError(`Sloupec ${key} v tabulce ${table.name} není.`, "invalid");
      const v = where[key];
      const value = (x: unknown) => encode({ ...col, required: true }, x);
      if (v === null) parts.push(`${q(key)} IS NULL`);
      else if (Array.isArray(v)) {
        if (!v.length || v.length > 1000) throw new DataError(`Seznam hodnot pro ${key} musí mít 1 až 1000 položek.`, "invalid");
        parts.push(`${q(key)} IN (${v.map(() => "?").join(", ")})`);
        args.push(...v.map(value));
      } else {
        parts.push(`${q(key)} = ?`);
        args.push(value(v));
      }
    }
    return { sql: parts.join(" AND "), args };
  }

  private async setDescription(name: string, description: string) {
    await this.db.execute({
      sql: `INSERT INTO ${META} (name, description) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET description = excluded.description`,
      args: [name, description.trim().slice(0, 500)],
    });
  }

  private async checkRoom() {
    const { bytes } = await this.limits();
    if (bytes !== null && (await this.size()) >= bytes) throw new DataError("Databáze firmy je plná. Smaž nepotřebné záznamy nebo tabulky.", "quota");
  }
}
