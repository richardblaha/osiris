import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDevVerifier, toIdentity } from "../src/auth/oidc.ts";
import { accessFromClaims, accessibleTenants, isAuthorized, isSystemAdmin, membershipsFromClaims } from "../src/auth/tenants.ts";
import { tursoProvider } from "../src/tenants/provider.ts";
import { createTestTenants } from "./helpers.ts";

describe("access from PocketID claims", () => {
  it("maps tenant to member and tenant-admin to admin, from single values or comma-separated lists", () => {
    const access = accessFromClaims((key) => ({ role: "osiris-user", tenant: "acme, novak-stavby,Bad", "tenant-admin": ["acme", "beta"] })[key]);
    expect(isAuthorized(access)).toBe(true);
    expect(membershipsFromClaims(access)).toEqual([
      { tenantId: "acme", role: "admin" },
      { tenantId: "beta", role: "admin" },
      { tenantId: "novak-stavby", role: "member" },
    ]);
  });

  it("requires the role osiris-user or osiris-admin", async () => {
    const without = accessFromClaims((key) => ({ tenant: "acme", role: "admin" })[key]);
    expect(isAuthorized(without)).toBe(false);
    expect(await accessibleTenants(without, { list: async () => [] } as never)).toEqual([]);
    const admin = accessFromClaims((key) => ({ role: "osiris-admin" })[key]);
    expect(isAuthorized(admin) && isSystemAdmin(admin)).toBe(true);
    expect(await accessibleTenants(admin, { list: async () => [{ id: "x", name: "X", members: 0 }] } as never)).toEqual([
      { tenantId: "x", role: "admin" },
    ]);
  });

  it("reads profile, phone and access claims from userinfo", () => {
    expect(toIdentity({ sub: "s", email: "a@b.cz", name: "A", phone_number: "+420777123456", role: "osiris-user", tenant: "a", groups: ["x"] })).toEqual({
      sub: "s",
      email: "a@b.cz",
      name: "A",
      phone: "+420777123456",
      picture: null,
      access: { roles: ["osiris-user"], tenants: ["a"], adminTenants: [] },
      claimKeys: ["email", "groups", "name", "phone_number", "role", "sub", "tenant"],
    });
  });

  it("dev verifier gives a user their own tenant unless claims are given", async () => {
    const dev = createDevVerifier();
    expect((await dev.identify("alice")).access).toEqual({ roles: ["osiris-user"], tenants: [], adminTenants: ["alice"] });
    expect((await dev.identify("bob:tenant=acme,beta&role=osiris-admin")).access).toEqual({
      roles: ["osiris-admin"],
      tenants: ["acme", "beta"],
      adminTenants: [],
    });
    await expect(dev.identify("../x")).rejects.toThrow();
  });
});

describe("tenant storage", () => {
  it("gives each tenant its own database file, opened once", async () => {
    const { tenants, dir } = createTestTenants();
    const a = await tenants.get("acme");
    await a.knowledge.addDocument("Ceník", "Sazba 650 Kč.");
    const b = await tenants.get("beta");

    expect(await tenants.get("acme")).toBe(a);
    expect(existsSync(join(dir, "acme.db")) && existsSync(join(dir, "beta.db"))).toBe(true);
    expect(await b.knowledge.listDocuments()).toEqual([]);
    expect(await b.knowledge.search("sazba")).toEqual([]);
  });

  it("refuses a run whose tenant differs from the graph's", async () => {
    const { tenants } = createTestTenants();
    const a = await tenants.get("acme");
    const ctx = { thread_id: "t", tenant_id: "beta", user_id: "u", role: "admin" as const, channel: "web" as const };
    await expect(a.graph.invoke({ messages: [] }, { configurable: ctx })).rejects.toThrow(/tenant beta/);
  });

  it("finds or creates a Turso database per tenant", async () => {
    const calls: string[] = [];
    const responses = [new Response("", { status: 404 }), Response.json({ database: { Hostname: "osiris-acme-org.turso.io" } })];
    const provider = tursoProvider({
      org: "org",
      group: "default",
      apiToken: "api",
      dbToken: "db",
      prefix: "osiris-",
      fetch: async (url, init) => {
        calls.push(`${init?.method ?? "GET"} ${String(url)} ${init?.body ?? ""}`.trim());
        return responses.shift()!;
      },
    });

    expect(await provider.locate("acme")).toEqual({ url: "libsql://osiris-acme-org.turso.io", authToken: "db" });
    expect(calls).toEqual([
      "GET https://api.turso.tech/v1/organizations/org/databases/osiris-acme",
      'POST https://api.turso.tech/v1/organizations/org/databases {"name":"osiris-acme","group":"default"}',
    ]);
  });
});
