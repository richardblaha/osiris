import { describe, expect, it } from "vitest";
import { createTestControl } from "./helpers.ts";

const admin = { systemAdmin: true };

describe("tenant directory", () => {
  it("creates tenants, keeps members in the users' claims and the cluster in step", async () => {
    const { directory, users, orchestrator, store } = await createTestControl({
      users: [{ id: "bob", name: "Bob", claims: { phone_number: "+420777123456", tenant: "acme" } }],
    });
    await directory.create("acme", "ACME s.r.o.");
    await directory.create("novak", "Novák stavby", { mcp: false });
    await expect(directory.create("acme", "Dup")).rejects.toThrow("already exists");
    expect(orchestrator.applied.get("novak")).toEqual({ id: "novak", name: "Novák stavby", suspended: false, idleMinutes: 30, storageGb: 5, domains: [] });
    expect((await store.get("novak"))!.features).toMatchObject({ mcp: false, knowledge: true, scheduler: true });

    await directory.setRole("novak", "bob", "admin");
    // Membership is written to the user's claims, keeping the others; a new member also gets the Osiris role.
    expect((await users.get("bob")).claims).toEqual({ phone_number: "+420777123456", tenant: "acme", "tenant-admin": "novak", role: "osiris-user" });
    expect(await directory.list()).toEqual([
      { id: "acme", name: "ACME s.r.o.", members: 1 },
      { id: "novak", name: "Novák stavby", members: 1 },
    ]);

    await directory.remove("novak");
    expect((await users.get("bob")).claims).toEqual({ phone_number: "+420777123456", tenant: "acme", role: "osiris-user" });
    expect(orchestrator.applied.get("novak")!.suspended).toBe(true);
    expect((await directory.list()).map((t) => t.id)).toEqual(["acme"]);
    // An archived tenant can be created again under its id.
    await directory.create("novak", "Novák znovu");
    expect(orchestrator.applied.get("novak")!.suspended).toBe(false);
  });

  it("invites existing users by email and creates new ones with a sign-in link", async () => {
    const { directory, users } = await createTestControl({ users: [{ id: "eva", email: "eva@firma.cz", claims: {} }] });
    await directory.create("acme", "ACME");
    expect(await directory.invite("acme", { email: "EVA@firma.cz", firstName: "Eva", lastName: "" }, "member")).toEqual({ userId: "eva", created: false });
    const created = await directory.invite("acme", { email: "eva@jinde.cz", firstName: "Eva", lastName: "Nová" }, "admin");
    expect(created).toMatchObject({ created: true, loginLink: expect.stringMatching(/^http:\/\/osiris\.test\/auth\/link\/[\w-]{43}$/) });
    expect(await users.get(created.userId)).toMatchObject({ email: "eva@jinde.cz", name: "Eva Nová", claims: { "tenant-admin": "acme", role: "osiris-user" } });
  });
});

describe("control API", () => {
  it("describes the user and their active tenants", async () => {
    const { asUser, directory } = await createTestControl();
    await directory.create("acme", "ACME s.r.o.");
    const me = await (await asUser("alice", [{ tenantId: "acme", role: "member" }, { tenantId: "gone", role: "admin" }])("/me")).json();
    expect(me).toEqual({
      user: { id: "alice", email: "alice@example.cz", name: "alice", phone: null, picture: null },
      systemAdmin: false,
      tenants: [{ id: "acme", name: "ACME s.r.o.", role: "member" }],
    });
    expect(await (await asUser("alice", [{ tenantId: "acme", role: "member" }])("/tenant")).json()).toMatchObject({ id: "acme", role: "member" });
    // Only memberships the gateway vouched for.
    expect((await asUser("alice", [{ tenantId: "acme", role: "member" }], { tenant: "beta" })("/tenant")).status).toBe(403);
  });

  it("refuses calls that don't come from the gateway", async () => {
    const { app, signer } = await createTestControl();
    expect((await app.request("/api/me")).status).toBe(401);
    // Control's own key pair signs as "control", which the user API doesn't accept.
    const forged = await signer.header("control", { user: { sub: "x", name: null, email: null, phone: null, picture: null } });
    expect((await app.request("/api/me", { headers: { authorization: forged } })).status).toBe(401);
  });

  it("lets only system admins manage tenants", async () => {
    const { asUser, users } = await createTestControl({ users: [{ id: "bob", name: "Bob", claims: { tenant: "acme" } }] });
    const root = asUser("root", [], admin);
    const json = (body: object) => ({ body: JSON.stringify(body) });
    expect((await asUser("alice", [{ tenantId: "acme", role: "admin" }])("/admin/tenants")).status).toBe(403);
    expect((await root("/admin/tenants", { method: "POST", ...json({ id: "Bad Slug", name: "X" }) })).status).toBe(400);
    expect((await root("/admin/tenants", { method: "POST", ...json({ id: "novak", name: "Novák", features: { mcp: false } }) })).status).toBe(201);
    expect((await root("/admin/tenants", { method: "POST", ...json({ id: "novak", name: "Dup" }) })).status).toBe(409);
    expect((await root("/admin/tenants/novak/members/bob", { method: "PUT", ...json({ role: "admin" }) })).status).toBe(204);
    expect((await root("/admin/tenants/novak/members/nobody", { method: "PUT", ...json({ role: "admin" }) })).status).toBe(404);
    expect((await root("/admin/tenants/novak", { method: "PATCH", ...json({ name: "Novák a syn", idleMinutes: 0, features: { http: false } }) })).status).toBe(204);
    const detail = await (await root("/admin/tenants/novak")).json();
    expect(detail).toMatchObject({ id: "novak", name: "Novák a syn", idleMinutes: 0, memberList: [{ userId: "bob", role: "admin" }], backups: [] });
    expect(detail.features).toMatchObject({ knowledge: true, mcp: false, http: false });
    expect((await root("/admin/tenants/nope")).status).toBe(404);
    expect((await root("/admin/tenants/novak", { method: "DELETE" })).status).toBe(204);
    expect((await users.get("bob")).claims).toEqual({ tenant: "acme", role: "osiris-user" });
  });

  it("lets tenant admins manage their own members only", async () => {
    const { asUser, directory } = await createTestControl({
      users: [
        { id: "bob", email: "bob@acme.cz", claims: { tenant: "acme", role: "osiris-user" } },
        { id: "carol", email: "carol@beta.cz", claims: { tenant: "beta", role: "osiris-user" } },
      ],
    });
    await directory.create("acme", "ACME");
    await directory.create("beta", "Beta");
    const alice = asUser("alice", [{ tenantId: "acme", role: "admin" }]);
    const bob = asUser("bob", [{ tenantId: "acme", role: "member" }]);
    expect((await bob("/members")).status).toBe(403);
    expect((await (await alice("/members")).json()).map((m: { userId: string }) => m.userId)).toEqual(["bob"]);
    // Someone else's member can't be changed through this tenant.
    expect((await alice("/members/carol", { method: "PUT", body: JSON.stringify({ role: "admin" }) })).status).toBe(404);
    expect((await alice("/members/bob", { method: "PUT", body: JSON.stringify({ role: "admin" }) })).status).toBe(204);
    const invited = await alice("/members", { method: "POST", body: JSON.stringify({ email: "dan@acme.cz", firstName: "Dan", lastName: "D" }) });
    expect(await invited.json()).toMatchObject({ created: true, loginLink: expect.any(String) });
    expect((await alice("/members/bob", { method: "DELETE" })).status).toBe(204);
  });

  it("edits the user's profile and checks the picture type", async () => {
    const { app, asUser, users } = await createTestControl({ users: [{ id: "alice", firstName: "Alice", lastName: "A", email: "a@x.cz", claims: {} }] });
    const alice = asUser("alice");
    expect(await (await alice("/me/profile", { method: "PATCH", body: JSON.stringify({ lastName: "Nováková" }) })).json()).toMatchObject({
      firstName: "Alice",
      lastName: "Nováková",
    });
    expect((await users.get("alice")).name).toBe("Alice Nováková");
    expect((await alice("/me/profile", { method: "PATCH", body: JSON.stringify({ email: "not-an-email" }) })).status).toBe(400);
    expect((await alice("/me/picture", { method: "PUT", body: "<svg/>", headers: { "content-type": "image/svg+xml" } })).status).toBe(415);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0]);
    expect((await alice("/me/picture", { method: "PUT", body: png, headers: { "content-type": "image/png" } })).status).toBe(204);
    // The picture is served at a URL that changes with every new one.
    const picture = (await users.get("alice")).picture!;
    expect(picture).toMatch(/^http:\/\/osiris\.test\/auth\/pictures\/alice\/[\w-]{16}$/);
    const served = await app.request(new URL(picture).pathname);
    expect([served.status, served.headers.get("content-type"), Buffer.from(await served.arrayBuffer())]).toEqual([200, "image/png", png]);
    expect((await app.request("/auth/pictures/alice/old")).status).toBe(404);
  });

  it("serves runtimes their own tenant only, as their token says", async () => {
    const { app, asRuntime, directory } = await createTestControl();
    await directory.create("acme", "ACME");
    expect(await (await asRuntime("acme")("/tenant")).json()).toMatchObject({ id: "acme", features: { files: true } });
    expect((await asRuntime("nope")("/tenant")).status).toBe(404);
    expect((await app.request("/internal/runtime/tenant", { headers: { authorization: "Bearer acme" } })).status).toBe(401);
    expect((await asRuntime("acme")("/backups/latest")).status).toBe(404);
  });

  it("tells the gateway where runtimes are and wakes them", async () => {
    const { app, directory, orchestrator } = await createTestControl();
    await directory.create("acme", "ACME");
    const { InternalSigner } = await import("@osiris/platform/internal-auth.ts");
    const { keys } = await import("./helpers.ts");
    const gw = await new InternalSigner(keys.privateKey, "gateway").header("control");
    expect(await (await app.request("/internal/gateway/tenants", { headers: { authorization: gw } })).json()).toEqual([{ id: "acme", name: "ACME" }]);
    expect(await (await app.request("/internal/gateway/tenants/acme/endpoint", { headers: { authorization: gw } })).json()).toEqual({ url: "http://runtime-acme" });
    expect((await app.request("/internal/gateway/tenants/acme/wake", { method: "POST", headers: { authorization: gw } })).status).toBe(204);
    expect((await app.request("/internal/gateway/tenants/nope/wake", { method: "POST", headers: { authorization: gw } })).status).toBe(404);
    expect(orchestrator.woken).toEqual(["acme"]);
  });
});

describe("users", () => {
  it("keeps other claims, refuses taken emails and unverifies a changed one", async () => {
    const { users } = await createTestControl({ users: [{ id: "bob", firstName: "Bob", lastName: "Novák", email: "b@x.cz", claims: { phone_number: "+420777123456", tenant: "acme" } }] });
    await Promise.all([users.setClaims("bob", { "tenant-admin": "beta" }), users.setClaims("bob", { phone_number: null })]);
    expect((await users.get("bob")).claims).toEqual({ tenant: "acme", "tenant-admin": "beta" });
    await expect(users.create({ email: "B@X.cz", firstName: "Jiný", lastName: "" })).rejects.toThrow("e-mailem už existuje");
    expect((await users.findByEmail(" B@x.CZ "))?.id).toBe("bob");

    await users.markEmailVerified("bob");
    expect((await users.get("bob")).emailVerified).toBe(true);
    expect(await users.updateProfile("bob", { email: "Nova@X.cz" })).toMatchObject({ email: "nova@x.cz", emailVerified: false, name: "Bob Novák" });
    await expect(users.setClaims("nobody", { tenant: "x" })).rejects.toThrow("not found");
  });
});
