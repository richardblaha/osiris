import { DB_COLUMN_TYPES, type DbQueryResult, type DbRows, type DbTable } from "@osiris/shared";
import { DataError, MAX_ROWS_PER_WRITE, type DataErrorCode } from "@osiris/core/database/store.ts";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AuthEnv, RequestContext } from "./auth.ts";
import { HttpError, ValidationError } from "@osiris/platform/i18n.ts";

const STATUS: Record<DataErrorCode, 400 | 404 | 409 | 507> = { invalid: 400, not_found: 404, exists: 409, quota: 507 };

const column = z.object({
  name: z.string().max(63),
  type: z.enum(DB_COLUMN_TYPES),
  required: z.boolean().optional(),
  unique: z.boolean().optional(),
  references: z.string().max(63).nullable().optional(),
});
const createBody = z.object({ name: z.string().max(63), description: z.string().max(500).default(""), columns: z.array(column).min(1).max(100) });
const alterBody = z.object({
  description: z.string().max(500).optional(),
  rename: z.string().max(63).optional(),
  addColumns: z.array(column).max(100).optional(),
  renameColumns: z.array(z.object({ from: z.string().max(63), to: z.string().max(63) })).max(100).optional(),
  dropColumns: z.array(z.string().max(63)).max(100).optional(),
});
const row = z.record(z.string(), z.unknown());
const insertBody = z.object({ rows: z.array(row).min(1).max(MAX_ROWS_PER_WRITE) });
const rowsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  order: z.string().max(63).optional(),
  desc: z.enum(["true", "false"]).optional(),
  search: z.string().max(200).optional(),
});
const queryBody = z.object({ sql: z.string().min(1).max(10_000) });
const rowId = (value: string) => {
  const id = Number(value);
  if (!Number.isSafeInteger(id)) throw new HttpError(400, "errors.db.rowId");
  return id;
};

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value, { reportInput: true });
  if (!r.success) throw new ValidationError(r.error);
  return r.data;
}

async function data<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (err) {
    if (err instanceof DataError) throw new HttpError(STATUS[err.code], err.key, err.params);
    throw err;
  }
}

/** Tables are the admins' to shape (what the agent does for members aside); rows and reading are every member's. */
const requireAdmin = (ctx: RequestContext) => {
  if (ctx.role !== "admin") throw new HttpError(403, "errors.db.adminOnly");
};

/** The tenant's database (Tenant > Databáze): tables, their rows, and read-only SQL. Mounted at /api/database. */
export function databaseRoutes() {
  return new Hono<AuthEnv>()
    .get("/tables", async (c) => c.json<DbTable[]>(await data(() => c.get("ctx").tenant.data.tables())))
    .post("/tables", async (c) => {
      const ctx = c.get("ctx");
      requireAdmin(ctx);
      const { name, description, columns } = parse(createBody, await c.req.json());
      return c.json<DbTable>(await data(() => ctx.tenant.data.createTable(name, description, columns)), 201);
    })
    .get("/tables/:table", async (c) => c.json<DbTable>(await data(() => c.get("ctx").tenant.data.table(c.req.param("table")))))
    .patch("/tables/:table", async (c) => {
      const ctx = c.get("ctx");
      requireAdmin(ctx);
      const change = parse(alterBody, await c.req.json());
      return c.json<DbTable>(await data(() => ctx.tenant.data.alterTable(c.req.param("table"), change)));
    })
    .delete("/tables/:table", async (c) => {
      const ctx = c.get("ctx");
      requireAdmin(ctx);
      await data(() => ctx.tenant.data.dropTable(c.req.param("table")));
      return c.body(null, 204);
    })
    .get("/tables/:table/rows", async (c) => {
      const q = parse(rowsQuery, c.req.query());
      return c.json<DbRows>(await data(() => c.get("ctx").tenant.data.rows(c.req.param("table"), { ...q, desc: q.desc === "true" })));
    })
    .post("/tables/:table/rows", async (c) => {
      const { rows } = parse(insertBody, await c.req.json());
      return c.json({ ids: await data(() => c.get("ctx").tenant.data.insert(c.req.param("table"), rows)) }, 201);
    })
    .patch("/tables/:table/rows/:id", async (c) => {
      const values = parse(row, await c.req.json());
      const n = await data(() => c.get("ctx").tenant.data.update(c.req.param("table"), { id: rowId(c.req.param("id")) }, values));
      if (!n) throw new HttpError(404, "errors.db.rowNotFound");
      return c.body(null, 204);
    })
    .delete("/tables/:table/rows/:id", async (c) => {
      const n = await data(() => c.get("ctx").tenant.data.delete(c.req.param("table"), { id: rowId(c.req.param("id")) }));
      if (!n) throw new HttpError(404, "errors.db.rowNotFound");
      return c.body(null, 204);
    })
    .post("/query", async (c) => {
      const { sql } = parse(queryBody, await c.req.json());
      return c.json<DbQueryResult>(await data(() => c.get("ctx").tenant.data.query(sql, 1000)));
    });
}
