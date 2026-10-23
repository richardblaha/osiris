import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { describe, expect, it } from "vitest";
import { databaseTools } from "@osiris/core/agent/tools/database.ts";
import { createDb } from "@osiris/core/db/client.ts";
import { DataError, DataStore, readOnlySql } from "@osiris/core/database/store.ts";
import { NO_QUOTAS } from "@osiris/shared";
import { createTestApp, createTestTenants } from "./helpers.ts";

const store = (limits = { tables: null as number | null, bytes: null as number | null }) => {
  const path = join(mkdtempSync(join(tmpdir(), "osiris-data-")), "data.db");
  return new DataStore(createDb(`file:${path}`), path, async () => limits);
};

const crm = async (data: DataStore) => {
  await data.createTable("contacts", "Kontakty", [
    { name: "name", type: "text", required: true },
    { name: "email", type: "text", unique: true },
    { name: "vip", type: "boolean" },
    { name: "extra", type: "json" },
  ]);
  await data.createTable("deals", "Obchody", [
    { name: "contact_id", type: "integer", references: "contacts" },
    { name: "value", type: "real" },
    { name: "closed_on", type: "date" },
  ]);
};

describe("readOnlySql", () => {
  it("lets one SELECT through and refuses everything else", () => {
    expect(readOnlySql("SELECT ';' AS a; -- konec;")).toBe("SELECT ';' AS a");
    expect(readOnlySql("with x as (select 1) select * from x")).toBe("with x as (select 1) select * from x");
    expect(readOnlySql('SELECT "attach" FROM t')).toBe('SELECT "attach" FROM t');
    for (const bad of ["SELECT 1; SELECT 2", "ATTACH 'tenant.db' AS t", "SELECT 1 FROM t; ATTACH 'x' AS y", "PRAGMA table_info(t)", "DELETE FROM t", "SELECT 'x", "SELECT 1 /* x", "VACUUM INTO 'x'"]) {
      expect(() => readOnlySql(bad), bad).toThrow(DataError);
    }
  });
});

describe("DataStore", () => {
  it("creates tables, checks values and constraints, and answers queries", async () => {
    const data = store();
    await crm(data);
    const tables = await data.tables();
    expect(tables.map((t) => t.name)).toEqual(["contacts", "deals"]);
    expect(tables[0]!.columns.map((c) => [c.name, c.type, c.required, c.unique])).toEqual([
      ["id", "integer", true, true],
      ["name", "text", true, false],
      ["email", "text", false, true],
      ["vip", "boolean", false, false],
      ["extra", "json", false, false],
      ["created_at", "datetime", true, false],
      ["updated_at", "datetime", true, false],
    ]);
    expect(tables[1]!.columns.find((c) => c.name === "contact_id")!.references).toBe("contacts");

    const [jana, petr] = await data.insert("contacts", [
      { name: "Jana", email: "jana@example.cz", vip: true, extra: { city: "Brno" } },
      { name: "Petr", vip: "false" },
    ]);
    await expect(data.insert("contacts", [{ name: "Eva", email: "jana@example.cz" }])).rejects.toThrow(/column email is already in the table/);
    await expect(data.insert("contacts", [{ email: "x@example.cz" }])).rejects.toThrow(/name is required/);
    await expect(data.insert("contacts", [{ name: "X", phone: "1" }])).rejects.toThrow(/Table contacts has no column phone/);
    await expect(data.insert("deals", [{ contact_id: 999, value: 1 }])).rejects.toThrow(/reference doesn't match/);
    await expect(data.insert("deals", [{ value: "hodně" }])).rejects.toThrow(/value expects a number/);
    await data.insert("deals", [
      { contact_id: jana, value: "1500,5", closed_on: "2026-10-01" },
      { contact_id: jana, value: 500 },
      { contact_id: petr, value: 100 },
    ]);

    expect(await data.update("contacts", { id: petr! }, { vip: true })).toBe(1);
    await expect(data.update("contacts", {}, { vip: true })).rejects.toThrow(/where/);
    const page = await data.rows("contacts", { search: "brno" });
    expect(page.total).toBe(1);
    expect(page.rows[0]).toMatchObject({ name: "Jana", vip: true, extra: { city: "Brno" } });

    const r = await data.query("SELECT c.name, SUM(d.value) AS total FROM contacts c JOIN deals d ON d.contact_id = c.id GROUP BY c.name ORDER BY total DESC");
    expect(r).toEqual({ columns: ["name", "total"], rows: [["Jana", 2000.5], ["Petr", 100]], truncated: false });
    expect((await data.query("SELECT value FROM deals", 2)).truncated).toBe(true);
    await expect(data.query("SELECT * FROM missing")).rejects.toThrow(/no such table/);

    // Deleting a contact leaves its deals without one.
    expect(await data.delete("contacts", { id: [jana!] })).toBe(1);
    expect((await data.query("SELECT COUNT(*) FROM deals WHERE contact_id IS NULL")).rows).toEqual([[2]]);
  });

  it("alters and drops tables", async () => {
    const data = store();
    await crm(data);
    await data.insert("contacts", [{ name: "Jana", email: "a@b.cz" }]);
    const t = await data.alterTable("contacts", {
      addColumns: [{ name: "phone", type: "text", unique: true }],
      renameColumns: [{ from: "name", to: "full_name" }],
      dropColumns: ["email"],
      rename: "people",
      description: "Lidé",
    });
    expect(t).toMatchObject({ name: "people", description: "Lidé", rows: 1 });
    expect(t.columns.map((c) => c.name)).toEqual(["id", "full_name", "vip", "extra", "created_at", "updated_at", "phone"]);
    // The deals follow the renamed table.
    expect((await data.table("deals")).columns.find((c) => c.name === "contact_id")!.references).toBe("people");
    await expect(data.alterTable("people", { addColumns: [{ name: "x", type: "text", required: true }] })).rejects.toThrow(/can't be required/);
    await data.dropTable("deals");
    expect((await data.tables()).map((x) => x.name)).toEqual(["people"]);
  });

  it("keeps to the quotas", async () => {
    const data = store({ tables: 1, bytes: null });
    await data.createTable("a", "", [{ name: "x", type: "text" }]);
    await expect(data.createTable("b", "", [{ name: "x", type: "text" }])).rejects.toMatchObject({ code: "quota" });
    const full = store({ tables: null, bytes: 1 });
    await expect(full.createTable("a", "", [{ name: "x", type: "text" }])).rejects.toMatchObject({ code: "quota" });
  });

  it("stops a runaway query without holding the runtime", async () => {
    const data = store();
    const started = Date.now();
    await expect(data.query("WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT COUNT(*) FROM c")).rejects.toThrow(/took longer than/);
    expect(Date.now() - started).toBeLessThan(8000);
  }, 15_000);
});

describe("database tools and API", () => {
  it("lets the agent fill tables but only admins drop them", async () => {
    const data = store();
    const tools = Object.fromEntries(databaseTools(data).map((t) => [t.name, t as StructuredToolInterface]));
    const config = (role: "admin" | "member") => ({ configurable: { thread_id: "t", tenant_id: "a", user_id: "u", role, channel: "web" } });
    const call = async (name: string, args: object, role: "admin" | "member" = "member") => JSON.parse(await tools[name]!.invoke(args, config(role)));
    expect(await call("db_create_table", { name: "contacts", columns: [{ name: "name", type: "text" }] })).toMatchObject({ success: true });
    expect(await call("db_insert", { table: "contacts", rows: [{ name: "Jana" }] })).toEqual({ success: true, ids: [1] });
    expect(await call("db_query", { sql: "ATTACH 'x' AS y" })).toMatchObject({ success: false });
    expect(await call("db_drop_table", { table: "contacts" })).toMatchObject({ success: false });
    expect(await call("db_alter_table", { table: "contacts", drop_columns: ["name"] })).toMatchObject({ success: false });
    expect(await call("db_drop_table", { table: "contacts" }, "admin")).toEqual({ success: true, dropped: "contacts" });
  });

  it("serves the browser: admins shape tables, members edit rows", async () => {
    const { tenants } = createTestTenants();
    const app = await createTestApp(tenants);
    const as = (user: string) => (path: string, init: RequestInit = {}) =>
      app.request(`/api${path}`, { ...init, headers: { authorization: `Bearer ${user}`, "content-type": "application/json", ...init.headers } });
    const acme = as("acme");
    const bob = as("bob:tenant=acme");
    const json = (body: object) => ({ method: "POST", body: JSON.stringify(body) });
    const table = { name: "contacts", columns: [{ name: "name", type: "text", required: true }] };
    expect((await bob("/database/tables", json(table))).status).toBe(403);
    expect((await acme("/database/tables", json(table))).status).toBe(201);
    expect(await (await bob("/database/tables/contacts/rows", json({ rows: [{ name: "Jana" }, { name: "Petr" }] }))).json()).toEqual({ ids: [1, 2] });
    expect((await bob("/database/tables/contacts/rows/2", { method: "PATCH", body: JSON.stringify({ name: "Pavel" }) })).status).toBe(204);
    expect((await bob("/database/tables/contacts/rows/9", { method: "DELETE" })).status).toBe(404);
    const rows = await (await bob("/database/tables/contacts/rows?order=name&desc=true")).json();
    expect(rows.rows.map((r: { name: string }) => r.name)).toEqual(["Pavel", "Jana"]);
    expect(await (await bob("/database/query", json({ sql: "SELECT COUNT(*) AS n FROM contacts" }))).json()).toEqual({ columns: ["n"], rows: [[2]], truncated: false });
    expect((await bob("/database/query", json({ sql: "DELETE FROM contacts" }))).status).toBe(400);

    (await tenants.get("acme")).features.limits = { ...NO_QUOTAS, tables: 1 };
    expect((await acme("/database/tables", json({ ...table, name: "other" }))).status).toBe(507);
  });
});
