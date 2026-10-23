import { tool } from "@langchain/core/tools";
import { DB_COLUMN_TYPES } from "@osiris/shared";
import { z } from "zod";
import { DataError, MAX_ROWS_PER_WRITE, type DataStore } from "../../database/store.ts";
import { getRunContext } from "../context.ts";

const answer = (value: object) => JSON.stringify(value);
/** A refusal the model can fix goes back as an answer, anything else fails the tool call. */
const run = async (action: () => Promise<object>) => {
  try {
    return answer({ success: true, ...(await action()) });
  } catch (err) {
    if (err instanceof DataError) return answer({ success: false, error: err.message });
    throw err;
  }
};

const tableName = z.string().trim().describe("Název tabulky (malá písmena bez diakritiky, číslice a _), např. contacts");
const column = z.object({
  name: z.string().trim().describe("Název sloupce (malá písmena bez diakritiky, číslice a _)"),
  type: z.enum(DB_COLUMN_TYPES).describe("text, integer, real, boolean, date (RRRR-MM-DD), datetime (ISO 8601), json"),
  required: z.boolean().optional().describe("Povinný sloupec"),
  unique: z.boolean().optional().describe("Hodnota se nesmí opakovat (např. e-mail)"),
  references: z.string().optional().describe("Tabulka, na jejíž id sloupec odkazuje (typ integer), např. contacts"),
});
const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const where = z
  .record(z.string(), z.union([scalar, z.array(z.union([z.string(), z.number()]))]))
  .describe('Které řádky: sloupec → hodnota (všechny musí platit), null = prázdné, seznam = kterákoli z hodnot. Např. {"id": 3} nebo {"id": [1, 2]}');
const values = z.record(z.string(), z.any()).describe("Sloupec → hodnota");

const ADMIN_ONLY = "Mazat tabulky a sloupce může jen správce firmy. Požádej ho, nebo data jen označ.";

/**
 * The project's database: tables the assistant defines and fills (contacts, deals…), shared by the whole project.
 * Writes are structured; reading is one SELECT. Dropping tables or columns (data loss) is the admins'.
 */
export function databaseTools(data: DataStore) {
  return [
    tool(async ({ table }) => run(async () => (table ? { table: await data.table(table) } : { tables: await data.tables() })), {
      name: "db_schema",
      description: "Vypíše tabulky databáze firmy s jejich sloupci a počtem řádků (nebo jednu tabulku). Použij před zápisem do tabulky, kterou neznáš.",
      schema: z.object({ table: tableName.optional() }),
    }),
    tool(async ({ name, description, columns }) => run(async () => ({ table: await data.createTable(name, description ?? "", columns) })), {
      name: "db_create_table",
      description:
        "Vytvoří tabulku v databázi firmy. Sloupce id, created_at a updated_at má každá tabulka sama. " +
        "Tabulky zakládej podle dovednosti, která je popisuje, nebo když o to uživatel požádá; nejdřív ověř db_schema, jestli už neexistuje.",
      schema: z.object({
        name: tableName,
        description: z.string().max(500).optional().describe("K čemu tabulka slouží, jednou větou"),
        columns: z.array(column).min(1).max(100),
      }),
    }),
    tool(
      async ({ table, description, rename, add_columns, rename_columns, drop_columns }, config) =>
        run(async () => {
          if (drop_columns?.length && getRunContext(config).role !== "admin") return { success: false, error: ADMIN_ONLY };
          return { table: await data.alterTable(table, { description, rename, addColumns: add_columns, renameColumns: rename_columns, dropColumns: drop_columns }) };
        }),
      {
        name: "db_alter_table",
        description: "Změní tabulku: přidá sloupce (nikdy povinné), přejmenuje sloupce nebo tabulku, změní popis, smaže sloupce (jen správce, data se ztratí).",
        schema: z.object({
          table: tableName,
          description: z.string().max(500).optional(),
          rename: z.string().optional().describe("Nový název tabulky"),
          add_columns: z.array(column).optional(),
          rename_columns: z.array(z.object({ from: z.string(), to: z.string() })).optional(),
          drop_columns: z.array(z.string()).optional(),
        }),
      },
    ),
    tool(
      async ({ table }, config) =>
        run(async () => {
          if (getRunContext(config).role !== "admin") return { success: false, error: ADMIN_ONLY };
          await data.dropTable(table);
          return { dropped: table };
        }),
      {
        name: "db_drop_table",
        description: "Smaže celou tabulku i s daty (jen správce, jen na jeho výslovný pokyn).",
        schema: z.object({ table: tableName }),
      },
    ),
    tool(async ({ table, rows }) => run(async () => ({ ids: await data.insert(table, rows) })), {
      name: "db_insert",
      description: `Vloží do tabulky 1 až ${MAX_ROWS_PER_WRITE} řádků najednou (všechny, nebo žádný); vrátí jejich id.`,
      schema: z.object({ table: tableName, rows: z.array(values).min(1).max(MAX_ROWS_PER_WRITE) }),
    }),
    tool(async ({ table, where: w, values: v }) => run(async () => ({ updated: await data.update(table, w, v) })), {
      name: "db_update",
      description: "Změní hodnoty sloupců u řádků, které odpovídají podmínce where; vrátí jejich počet.",
      schema: z.object({ table: tableName, where, values }),
    }),
    tool(async ({ table, where: w }) => run(async () => ({ deleted: await data.delete(table, w) })), {
      name: "db_delete",
      description: "Smaže řádky, které odpovídají podmínce where (jen na pokyn uživatele); vrátí jejich počet.",
      schema: z.object({ table: tableName, where }),
    }),
    tool(async ({ sql }) => run(async () => ({ ...(await data.query(sql)) })), {
      name: "db_query",
      description:
        "Přečte data jedním dotazem SQLite SELECT (i JOIN, GROUP BY, WITH). Vrátí nejvýš 200 řádků, u velkých tabulek proto filtruj a řaď. " +
        "Text hledej bez ohledu na velikost písmen přes LIKE, JSON sloupce přes json_extract. Data se mění jen nástroji db_insert, db_update a db_delete.",
      schema: z.object({ sql: z.string().min(1).max(10_000) }),
    }),
  ];
}
