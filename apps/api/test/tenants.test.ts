import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDevVerifier, toIdentity } from "../src/auth/oidc.ts";
import { membershipsFromGroups } from "../src/auth/tenants.ts";
import { tursoProvider } from "../src/tenants/provider.ts";
import { createTestTenants } from "./helpers.ts";

describe("tenant memberships from PocketID groups", () => {
  it("maps osiris-tenant-<slug> to member and osiris-tenant-<slug>-admin to admin", () => {
    expect(
      membershipsFromGroups([
        "osiris-tenant-acme",
        "osiris-tenant-acme-admin",
        "osiris-tenant-novak-stavby",
        "osiris-tenant-beta-admin",
        "admins",
        "osiris-tenant-Bad",
        // The old names no longer count.
        "tenant-old-admin",
      ]),
    ).toEqual([
      { tenantId: "acme", role: "admin" },
      { tenantId: "beta", role: "admin" },
      { tenantId: "novak-stavby", role: "member" },
    ]);
  });

  it("reads profile, phone and groups from userinfo", () => {
    expect(toIdentity({ sub: "s", email: "a@b.cz", name: "A", phone_number: "+420777123456", groups: ["osiris-tenant-a", 5] })).toEqual({
      sub: "s",
      email: "a@b.cz",
      name: "A",
      phone: "+420777123456",
      groups: ["osiris-tenant-a"],
    });
  });

  it("dev verifier gives a user their own tenant unless groups are given", async () => {
    const dev = createDevVerifier();
    expect((await dev.identify("alice")).groups).toEqual(["osiris-tenant-alice-admin"]);
    expect((await dev.identify("bob:osiris-tenant-acme")).groups).toEqual(["osiris-tenant-acme"]);
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
