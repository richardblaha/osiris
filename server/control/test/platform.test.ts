import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LocalDb, migrate } from "@osiris/platform/db.ts";
import { MIGRATIONS, tempDir } from "./helpers.ts";
import { CONTROL_AUDIENCE, generateInternalKeys, InternalSigner, InternalVerifier } from "@osiris/platform/internal-auth.ts";
import { deriveProjectKey } from "@osiris/platform/project-keys.ts";

describe("internal tokens", () => {
  it("carry the user between services and are refused for another audience, issuer or key", async () => {
    const keys = await generateInternalKeys();
    const signer = new InternalSigner(keys.privateKey, "gateway");
    const token = await signer.sign(CONTROL_AUDIENCE, { user: { sub: "u1", name: "A", email: null, phone: null, picture: null }, systemAdmin: true });
    expect(await new InternalVerifier(keys.publicKey).verify(token, CONTROL_AUDIENCE)).toMatchObject({ issuer: "gateway", user: { sub: "u1" }, systemAdmin: true });
    await expect(new InternalVerifier(keys.publicKey).verify(token, "project:acme")).rejects.toThrow("Invalid internal token");
    await expect(new InternalVerifier(keys.publicKey, ["control"]).verify(token, CONTROL_AUDIENCE)).rejects.toThrow("Invalid internal token");
    const other = await generateInternalKeys();
    await expect(new InternalVerifier(other.publicKey).verify(token, CONTROL_AUDIENCE)).rejects.toThrow("Invalid internal token");
    const expired = await signer.sign(CONTROL_AUDIENCE, {}, -10);
    await expect(new InternalVerifier(keys.publicKey).verify(expired, CONTROL_AUDIENCE)).rejects.toThrow("Invalid internal token");
  });
});

describe("project keys", () => {
  it("derives a different stable key per project", () => {
    const master = Buffer.alloc(32, 7).toString("base64");
    expect(deriveProjectKey(master, "acme")).toBe(deriveProjectKey(master, "acme"));
    expect(deriveProjectKey(master, "acme")).not.toBe(deriveProjectKey(master, "beta"));
    expect(Buffer.from(deriveProjectKey(master, "acme"), "base64")).toHaveLength(32);
    expect(() => deriveProjectKey("short", "acme")).toThrow("32 bytes");
  });
});

describe("migrations", () => {
  const write = (dir: string, files: Record<string, string>) => {
    for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql);
    return dir;
  };
  const old = () => write(tempDir(), { "001_init.sql": "CREATE TABLE a (id TEXT);\n", "002_b.sql": "CREATE TABLE b (id TEXT);\n", "003_c.sql": "CREATE TABLE c (id TEXT);\n" });
  const squashed = () =>
    write(tempDir(), {
      "001_init.sql": "-- baseline after: 003_c.sql\n-- baseline drops: b\nCREATE TABLE a (id TEXT);\nCREATE TABLE c (id TEXT);\n",
      "002_d.sql": "CREATE TABLE d (id TEXT);\n",
    });
  const names = async (db: LocalDb) => (await db.query<{ name: string }>("SELECT name FROM _migrations ORDER BY name", [])).map((r) => r.name);

  it("make a new database from the baseline", async () => {
    const db = new LocalDb(join(tempDir(), "new.db"));
    expect(await migrate(db, squashed())).toEqual(["001_init.sql", "002_d.sql"]);
  });

  it("take a database made before the baseline as being at it, keeping its data", async () => {
    const db = new LocalDb(join(tempDir(), "old.db"));
    await migrate(db, old());
    await db.execute([{ sql: "INSERT INTO c (id) VALUES ('kept')", args: [] }]);
    expect(await migrate(db, squashed())).toEqual(["002_d.sql"]);
    expect(await names(db)).toEqual(["001_init.sql", "002_d.sql"]);
    expect(await db.query("SELECT id FROM c", [])).toEqual([{ id: "kept" }]);
    expect((await db.query<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name", [])).map((r) => r.name)).toEqual(["_migrations", "a", "c", "d"]);
  });

  it("refuse a database older than what the baseline replaces", async () => {
    const before = old();
    rmSync(join(before, "003_c.sql"));
    const db = new LocalDb(join(tempDir(), "older.db"));
    await migrate(db, before);
    await expect(migrate(db, squashed())).rejects.toThrow(/003_c\.sql/);
  });

  it("take control's database from before the baseline without its old sign-in tables", async () => {
    const db = new LocalDb(join(tempDir(), "control.db"));
    await db.execute([
      { sql: "CREATE TABLE _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)", args: [] },
      { sql: "INSERT INTO _migrations (name, applied_at) VALUES ('001_init.sql', 1), ('002_auth.sql', 1), ('012_no_cluster_sites.sql', 1)", args: [] },
      { sql: "CREATE TABLE users (id TEXT PRIMARY KEY)", args: [] },
      { sql: "CREATE TABLE passkeys (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE)", args: [] },
      { sql: "INSERT INTO users (id) VALUES ('u1')", args: [] },
      { sql: "INSERT INTO passkeys (id, user_id) VALUES ('p1', 'u1')", args: [] },
    ]);
    expect(await migrate(db, MIGRATIONS)).toEqual([]);
    expect(await db.query("SELECT name FROM sqlite_master WHERE name IN ('users', 'passkeys')", [])).toEqual([]);
    expect(await db.query("SELECT name FROM _migrations", [])).toEqual([{ name: "001_init.sql" }]);
  });

  it("make control's schema from its one baseline", async () => {
    const db = new LocalDb(join(tempDir(), "control.db"));
    expect(await migrate(db, MIGRATIONS)).toEqual(["001_init.sql"]);
    const tables = (await db.query<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'", [])).map((r) => r.name);
    expect(tables).toEqual(expect.arrayContaining(["projects", "schedules", "wa_inbox", "wa_deliveries", "dashboards", "system_guards"]));
    expect(tables).not.toContain("users");
  });
});
