import { describe, expect, it } from "vitest";
import { TenantExistsError, TenantNotFoundError } from "../src/tenants/directory.ts";
import { tursoProvider } from "../src/tenants/provider.ts";
import { createTestDirectory, createTestTenants } from "./helpers.ts";

const person = (id: string, name: string, claims: Record<string, string> = {}, disabled = false) => ({ id, name, email: null, disabled, claims });

describe("tenants as databases, members as claims", () => {
  it("lists tenant databases with their names and the users whose claims name them", async () => {
    const { tenants } = createTestTenants();
    const { directory } = await createTestDirectory(tenants, [{ id: "k6labs", name: "K6 Labs" }, { id: "beta" }], [
      person("u1", "Bob Novák", { "tenant-admin": "k6labs", tenant: "beta" }),
      person("u2", "Eva", { tenant: "beta,k6labs" }),
      person("u3", "off", { tenant: "k6labs" }, true),
    ]);
    expect(await directory.list()).toEqual([
      { id: "beta", name: "beta", members: 2 },
      { id: "k6labs", name: "K6 Labs", members: 2 },
    ]);
    expect(await directory.members("k6labs")).toEqual([
      { userId: "u1", name: "Bob Novák", email: null, role: "admin" },
      { userId: "u2", name: "Eva", email: null, role: "member" },
    ]);
    expect(await directory.users()).toEqual([
      { id: "u1", name: "Bob Novák", email: null },
      { id: "u2", name: "Eva", email: null },
    ]);
    await expect(directory.members("nope")).rejects.toBeInstanceOf(TenantNotFoundError);
  });

  it("creates, renames, assigns roles through claims and removes", async () => {
    const { tenants, dir } = createTestTenants();
    const { directory, users } = await createTestDirectory(tenants, [], [person("u1", "Bob"), person("u2", "Eva", { role: "osiris-admin", tenant: "x" })]);
    await directory.create("acme", "ACME");
    await expect(directory.create("acme", "Again")).rejects.toBeInstanceOf(TenantExistsError);

    await directory.setRole("acme", "u1", "member");
    await directory.setRole("acme", "u2", "admin");
    await directory.setRole("acme", "u1", "admin");
    expect(users.users.map((u) => u.claims)).toEqual([
      { "tenant-admin": "acme", role: "osiris-user" },
      // An osiris-admin keeps their role.
      { role: "osiris-admin", tenant: "x", "tenant-admin": "acme" },
    ]);
    await directory.setRole("acme", "u2", null);
    expect((await directory.members("acme")).map((m) => [m.userId, m.role])).toEqual([["u1", "admin"]]);

    await directory.rename("acme", "ACME a.s.");
    expect(await directory.list()).toEqual([{ id: "acme", name: "ACME a.s.", members: 1 }]);
    await directory.remove("acme");
    await tenants.remove("acme");
    expect(users.users[0]!.claims).toEqual({ role: "osiris-user" });
    expect(await directory.list()).toEqual([]);

    // A new tenant with the same slug starts empty (the file database was archived).
    await directory.create("acme", "ACME znovu");
    expect(await directory.list()).toEqual([{ id: "acme", name: "ACME znovu", members: 0 }]);
    expect(dir).toBeTruthy();
  });

  it("hides an archived tenant whose database is kept", async () => {
    const { tenants } = createTestTenants();
    const { directory } = await createTestDirectory(tenants, [{ id: "acme", name: "ACME" }]);
    await (await tenants.get("acme")).profile.setArchived(true);
    expect(await directory.list()).toEqual([]);
    // Creating it again brings the data back.
    await directory.create("acme", "ACME");
    expect(await directory.list()).toEqual([{ id: "acme", name: "ACME", members: 0 }]);
  });

  it("lists Turso databases by prefix", async () => {
    const provider = tursoProvider({
      org: "org",
      group: "default",
      apiToken: "api",
      dbToken: "db",
      prefix: "osiris-",
      fetch: (async () => Response.json({ databases: [{ Name: "osiris-acme" }, { Name: "other" }, { Name: "osiris-beta" }] })) as unknown as typeof fetch,
    });
    expect(await provider.list()).toEqual(["acme", "beta"]);
  });
});
