import { describe, expect, it } from "vitest";
import { NO_QUOTAS } from "@osiris/shared";
import { createTestControl } from "./helpers.ts";

const admin = { systemAdmin: true };

describe("project directory", () => {
  it("creates projects, keeps members in the users' claims and the cluster in step", async () => {
    const { directory, users, orchestrator, store } = await createTestControl({
      users: [{ id: "bob", name: "Bob", claims: { phone_number: "+420777123456", project: "acme" } }],
    });
    await directory.create("acme", "ACME s.r.o.");
    await directory.create("novak", "Novák stavby", { mcp: false });
    await expect(directory.create("acme", "Dup")).rejects.toThrow("already exists");
    expect(orchestrator.applied.get("novak")).toEqual({ id: "novak", name: "Novák stavby", suspended: false, idleMinutes: 30, storageGb: 5, domains: [] });
    expect((await store.get("novak"))!.features).toMatchObject({ mcp: false, knowledge: true, scheduler: true });

    await directory.setRole("novak", "bob", "admin");
    // Membership is written to the user's claims, keeping the others; a new member also gets the Osiris role.
    expect((await users.get("bob")).claims).toEqual({ phone_number: "+420777123456", project: "acme", "project-admin": "novak", role: "osiris-user" });
    expect(await directory.list()).toEqual([
      { id: "acme", name: "ACME s.r.o.", logo: null, members: 1 },
      { id: "novak", name: "Novák stavby", logo: null, members: 1 },
    ]);

    await directory.remove("novak");
    expect((await users.get("bob")).claims).toEqual({ phone_number: "+420777123456", project: "acme", role: "osiris-user" });
    expect(orchestrator.applied.get("novak")!.suspended).toBe(true);
    expect((await directory.list()).map((t) => t.id)).toEqual(["acme"]);
    // An archived project can be created again under its id.
    await directory.create("novak", "Novák znovu");
    expect(orchestrator.applied.get("novak")!.suspended).toBe(false);
  });

  it("invites existing users by email and creates new ones with a sign-in link", async () => {
    const { directory, users } = await createTestControl({ users: [{ id: "eva", email: "eva@firma.cz", claims: {} }] });
    await directory.create("acme", "ACME");
    expect(await directory.invite("acme", { email: "EVA@firma.cz", firstName: "Eva", lastName: "" }, "member")).toEqual({ userId: "eva", created: false });
    const created = await directory.invite("acme", { email: "eva@jinde.cz", firstName: "Eva", lastName: "Nová" }, "admin");
    expect(created).toMatchObject({ created: true, loginLink: expect.stringMatching(/^http:\/\/osiris\.test\/auth\/link\/[\w-]{43}$/) });
    expect(await users.get(created.userId)).toMatchObject({ email: "eva@jinde.cz", name: "Eva Nová", claims: { "project-admin": "acme", role: "osiris-user" } });
  });
});

describe("control API", () => {
  it("describes the user and their active projects", async () => {
    const { asUser, directory } = await createTestControl();
    await directory.create("acme", "ACME s.r.o.");
    const me = await (await asUser("alice", [{ projectId: "acme", role: "member" }, { projectId: "gone", role: "admin" }])("/me")).json();
    expect(me).toEqual({
      user: { id: "alice", email: "alice@example.cz", name: "alice", phone: null, picture: null },
      systemAdmin: false,
      projects: [{ id: "acme", name: "ACME s.r.o.", role: "member", logo: null }],
    });
    expect(await (await asUser("alice", [{ projectId: "acme", role: "member" }])("/project")).json()).toMatchObject({ id: "acme", role: "member" });
    // Only memberships the gateway vouched for.
    expect((await asUser("alice", [{ projectId: "acme", role: "member" }], { project: "beta" })("/project")).status).toBe(403);
  });

  it("refuses calls that don't come from the gateway", async () => {
    const { app, signer } = await createTestControl();
    expect((await app.request("/api/me")).status).toBe(401);
    // Control's own key pair signs as "control", which the user API doesn't accept.
    const forged = await signer.header("control", { user: { sub: "x", name: null, email: null, phone: null, picture: null } });
    expect((await app.request("/api/me", { headers: { authorization: forged } })).status).toBe(401);
  });

  it("starts new projects and users with the system's defaults", async () => {
    const { asUser, asRuntime } = await createTestControl({ users: [] });
    const root = asUser("root", [], admin);
    const json = (body: object) => ({ body: JSON.stringify(body) });
    const defaults = await (await root("/admin/defaults")).json();
    expect(defaults).toMatchObject({ project: { idleMinutes: 30, storageGb: 5, quotas: { tokensPerMonth: null } }, user: { address: "auto", language: "auto" } });
    defaults.project.features.mcp = false;
    defaults.project.quotas.tokensPerMonth = 100_000;
    defaults.project.idleMinutes = 10;
    const persona = { character: "Holmes", source: "Pes baskervillský", description: "Stručně a dedukcí." };
    defaults.user = { address: "vy", language: "cs", signature: "Jan", instructions: "S DPH.", persona };
    expect((await asUser("alice", [{ projectId: "acme", role: "admin" }])("/admin/defaults", { method: "PUT", ...json(defaults) })).status).toBe(403);
    expect((await root("/admin/defaults", { method: "PUT", ...json(defaults) })).status).toBe(200);
    expect((await root("/admin/projects", { method: "POST", ...json({ id: "novak", name: "Novák", features: { http: false } }) })).status).toBe(201);
    const detail = await (await root("/admin/projects/novak")).json();
    expect(detail).toMatchObject({ idleMinutes: 10, quotas: { tokensPerMonth: 100_000 } });
    expect(detail.features).toMatchObject({ mcp: false, http: false, knowledge: true });
    expect(await (await asRuntime("novak")("/project")).json()).toMatchObject({ userDefaults: { address: "vy", language: "cs", signature: "Jan", persona } });
  });

  it("lets only system admins manage projects", async () => {
    const { asUser, asRuntime, users } = await createTestControl({ users: [{ id: "bob", name: "Bob", claims: { project: "acme" } }] });
    const root = asUser("root", [], admin);
    const json = (body: object) => ({ body: JSON.stringify(body) });
    expect((await asUser("alice", [{ projectId: "acme", role: "admin" }])("/admin/projects")).status).toBe(403);
    expect((await root("/admin/projects", { method: "POST", ...json({ id: "Bad Slug", name: "X" }) })).status).toBe(400);
    expect((await root("/admin/projects", { method: "POST", ...json({ id: "novak", name: "Novák", features: { mcp: false } }) })).status).toBe(201);
    expect((await root("/admin/projects", { method: "POST", ...json({ id: "novak", name: "Dup" }) })).status).toBe(409);
    expect((await root("/admin/projects/novak/members/bob", { method: "PUT", ...json({ role: "admin" }) })).status).toBe(204);
    expect((await root("/admin/projects/novak/members/nobody", { method: "PUT", ...json({ role: "admin" }) })).status).toBe(404);
    expect((await root("/admin/projects/novak", { method: "PATCH", ...json({ name: "Novák a syn", idleMinutes: 0, features: { http: false } }) })).status).toBe(204);
    const detail = await (await root("/admin/projects/novak")).json();
    expect(detail).toMatchObject({ id: "novak", name: "Novák a syn", idleMinutes: 0, memberList: [{ userId: "bob", role: "admin" }], backups: [] });
    expect(detail.features).toMatchObject({ knowledge: true, mcp: false, http: false });
    // Built-in tools are switched off by name; the runtime learns it with its features.
    expect((await root("/admin/projects/novak", { method: "PATCH", ...json({ disabledTools: ["Bad name"] }) })).status).toBe(400);
    expect((await root("/admin/projects/novak", { method: "PATCH", ...json({ disabledTools: ["remember", "http_request", "remember"] }) })).status).toBe(204);
    expect((await (await root("/admin/projects/novak")).json()).disabledTools).toEqual(["http_request", "remember"]);
    expect(await (await asRuntime("novak")("/project")).json()).toMatchObject({ disabledTools: ["http_request", "remember"] });
    expect((await root("/admin/projects/nope")).status).toBe(404);
    expect((await root("/admin/projects/novak", { method: "DELETE" })).status).toBe(204);
    expect((await users.get("bob")).claims).toEqual({ project: "acme", role: "osiris-user" });
  });

  it("lets system admins manage users: create, edit, block, promote, sign-in links", async () => {
    const { asUser, directory, users } = await createTestControl({
      users: [
        { id: "root", email: "root@k6labs.cz", claims: { role: "osiris-admin" } },
        { id: "bob", firstName: "Bob", lastName: "B", email: "bob@acme.cz", claims: { project: "acme", role: "osiris-user" } },
      ],
    });
    await directory.create("acme", "ACME");
    const root = asUser("root", [], admin);
    const json = (body: object) => ({ body: JSON.stringify(body) });
    expect((await asUser("bob", [{ projectId: "acme", role: "admin" }])("/admin/users")).status).toBe(403);

    const list = await (await root("/admin/users")).json();
    expect(list.find((u: { id: string }) => u.id === "bob")).toMatchObject({ email: "bob@acme.cz", systemAdmin: false, disabled: false, projects: [{ id: "acme", role: "member" }] });
    expect(list.find((u: { id: string }) => u.id === "root")).toMatchObject({ systemAdmin: true, projects: [] });

    expect((await root("/admin/users", { method: "POST", ...json({ email: "BOB@acme.cz", firstName: "B", lastName: "" }) })).status).toBe(409);
    const created = await root("/admin/users", { method: "POST", ...json({ email: "eva@firma.cz", firstName: "Eva", lastName: "Nová" }) });
    const { userId, loginLink } = await created.json();
    expect([created.status, loginLink]).toEqual([201, expect.stringMatching(/^http:\/\/osiris\.test\/auth\/link\//)]);
    expect(await users.get(userId)).toMatchObject({ name: "Eva Nová", claims: { role: "osiris-user" } });

    expect((await root("/admin/users/bob", { method: "PATCH", ...json({ lastName: "Novák", systemAdmin: true, disabled: true }) })).status).toBe(204);
    expect(await users.get("bob")).toMatchObject({ name: "Bob Novák", disabled: true, claims: { project: "acme", role: "osiris-admin" } });
    expect((await root("/admin/users/bob/login-link", { method: "POST" })).status).toBe(400);
    expect((await root("/admin/users/bob", { method: "PATCH", ...json({ systemAdmin: false, disabled: false }) })).status).toBe(204);
    expect((await users.get("bob")).claims.role).toBe("osiris-user");
    expect((await (await root("/admin/users/bob/login-link", { method: "POST" })).json()).loginLink).toMatch(/\/auth\/link\//);
    // A system admin can't lock themselves out.
    expect((await root("/admin/users/root", { method: "PATCH", ...json({ systemAdmin: false }) })).status).toBe(400);
    expect((await root("/admin/users/root", { method: "PATCH", ...json({ disabled: true }) })).status).toBe(400);
    expect((await root("/admin/users/nobody", { method: "PATCH", ...json({ disabled: true }) })).status).toBe(404);
  });

  it("keeps to the project's member and task quotas and tells the runtime", async () => {
    const { asUser, asRuntime, directory, schedules } = await createTestControl({
      users: [
        { id: "bob", email: "bob@acme.cz", claims: { project: "acme", role: "osiris-user" } },
        { id: "eva", email: "eva@acme.cz", claims: { role: "osiris-user" } },
      ],
    });
    await directory.create("acme", "ACME");
    const root = asUser("root", [], admin);
    const json = (body: object) => ({ body: JSON.stringify(body) });
    expect((await root("/admin/projects/acme", { method: "PATCH", ...json({ quotas: { members: 0 } }) })).status).toBe(400);
    expect((await root("/admin/projects/acme", { method: "PATCH", ...json({ quotas: { members: 1, schedules: 1, tokensPerMonth: 5000 } }) })).status).toBe(204);
    expect((await (await root("/admin/projects/acme")).json()).quotas).toEqual({ ...NO_QUOTAS, tokensPerMonth: 5000, members: 1, schedules: 1 });

    // The project is full: nobody new joins, but the member's role still changes.
    expect((await root("/admin/projects/acme/members/eva", { method: "PUT", ...json({ role: "member" }) })).status).toBe(400);
    expect((await root("/admin/projects/acme/members/bob", { method: "PUT", ...json({ role: "admin" }) })).status).toBe(204);

    const task = { title: "A", prompt: "p", runAt: new Date(Date.now() + 3_600_000).toISOString() };
    await schedules.create("acme", { id: "bob", name: "Bob" }, task);
    await expect(schedules.create("acme", { id: "bob", name: "Bob" }, task)).rejects.toThrow("at most 1");
    // System rules apply to every project's assistant.
    expect((await asUser("bob", [{ projectId: "acme", role: "admin" }])("/admin/guards/hesla", { method: "PUT", ...json({ rule: "x" }) })).status).toBe(403);
    expect((await root("/admin/guards/hesla", { method: "PUT", ...json({ description: "Hesla", rule: "Nikdy neprozrazuj hesla." }) })).status).toBe(200);
    expect((await root("/admin/guards/Spatne", { method: "PUT", ...json({ rule: "x" }) })).status).toBe(400);
    expect(await (await root("/admin/guards")).json()).toEqual([{ name: "hesla", description: "Hesla", rule: "Nikdy neprozrazuj hesla." }]);
    expect(await (await asRuntime("acme")("/project")).json()).toMatchObject({
      quotas: { tokensPerMonth: 5000, members: 1, schedules: 1 },
      counts: { members: 1, schedules: 1 },
      systemGuards: [{ name: "hesla", description: "Hesla", rule: "Nikdy neprozrazuj hesla." }],
    });
  });

  it("lets project admins manage their own members only", async () => {
    const { asUser, directory } = await createTestControl({
      users: [
        { id: "bob", email: "bob@acme.cz", claims: { project: "acme", role: "osiris-user" } },
        { id: "carol", email: "carol@beta.cz", claims: { project: "beta", role: "osiris-user" } },
      ],
    });
    await directory.create("acme", "ACME");
    await directory.create("beta", "Beta");
    const alice = asUser("alice", [{ projectId: "acme", role: "admin" }]);
    const bob = asUser("bob", [{ projectId: "acme", role: "member" }]);
    expect((await bob("/members")).status).toBe(403);
    expect((await (await alice("/members")).json()).map((m: { userId: string }) => m.userId)).toEqual(["bob"]);
    // Someone else's member can't be changed through this project.
    expect((await alice("/members/carol", { method: "PUT", body: JSON.stringify({ role: "admin" }) })).status).toBe(404);
    expect((await alice("/members/bob", { method: "PUT", body: JSON.stringify({ role: "admin" }) })).status).toBe(204);
    const invited = await alice("/members", { method: "POST", body: JSON.stringify({ email: "dan@acme.cz", firstName: "Dan", lastName: "D" }) });
    expect(await invited.json()).toMatchObject({ created: true, loginLink: expect.any(String) });
    expect((await alice("/members/bob", { method: "DELETE" })).status).toBe(204);
  });

  it("lets project admins set the project's logo, served at a URL that changes with it", async () => {
    const { app, asUser, directory } = await createTestControl();
    await directory.create("acme", "ACME");
    const alice = asUser("alice", [{ projectId: "acme", role: "admin" }]);
    const bob = asUser("bob", [{ projectId: "acme", role: "member" }]);
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0]);
    const put = (who: typeof alice, body: BodyInit) => who("/project/logo", { method: "PUT", body, headers: { "content-type": "image/png" } });
    expect((await put(bob, png)).status).toBe(403);
    expect((await put(alice, "<svg/>")).status).toBe(415);
    expect((await put(alice, png)).status).toBe(204);

    const logo = (await (await bob("/project")).json()).logo as string;
    expect(logo).toMatch(/^http:\/\/osiris\.test\/auth\/project-logos\/acme\/[\w-]{36}$/);
    expect((await (await bob("/me")).json()).projects).toMatchObject([{ id: "acme", logo }]);
    const served = await app.request(new URL(logo).pathname);
    expect([served.status, served.headers.get("content-type"), new Uint8Array(await served.arrayBuffer())]).toEqual([200, "image/png", png]);
    // A new logo replaces the old one, whose URL stops working.
    expect((await put(alice, png)).status).toBe(204);
    expect((await app.request(new URL(logo).pathname)).status).toBe(404);
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

  it("serves runtimes their own project only, as their token says", async () => {
    const { app, asRuntime, directory } = await createTestControl();
    await directory.create("acme", "ACME");
    expect(await (await asRuntime("acme")("/project")).json()).toMatchObject({ id: "acme", features: { files: true } });
    expect((await asRuntime("nope")("/project")).status).toBe(404);
    expect((await app.request("/internal/runtime/project", { headers: { authorization: "Bearer acme" } })).status).toBe(401);
    expect((await asRuntime("acme")("/backups/latest")).status).toBe(404);
  });

  it("tells the gateway where runtimes are and wakes them", async () => {
    const { app, directory, orchestrator } = await createTestControl();
    await directory.create("acme", "ACME");
    const { InternalSigner } = await import("@osiris/platform/internal-auth.ts");
    const { keys } = await import("./helpers.ts");
    const gw = await new InternalSigner(keys.privateKey, "gateway").header("control");
    expect(await (await app.request("/internal/gateway/projects", { headers: { authorization: gw } })).json()).toEqual([{ id: "acme", name: "ACME" }]);
    expect(await (await app.request("/internal/gateway/projects/acme/endpoint", { headers: { authorization: gw } })).json()).toEqual({ url: "http://runtime-acme" });
    expect((await app.request("/internal/gateway/projects/acme/wake", { method: "POST", headers: { authorization: gw } })).status).toBe(204);
    expect((await app.request("/internal/gateway/projects/nope/wake", { method: "POST", headers: { authorization: gw } })).status).toBe(404);
    expect(orchestrator.woken).toEqual(["acme"]);
  });
});

describe("users", () => {
  it("keeps other claims, refuses taken emails and unverifies a changed one", async () => {
    const { users } = await createTestControl({ users: [{ id: "bob", firstName: "Bob", lastName: "Novák", email: "b@x.cz", claims: { phone_number: "+420777123456", project: "acme" } }] });
    await Promise.all([users.setClaims("bob", { "project-admin": "beta" }), users.setClaims("bob", { phone_number: null })]);
    expect((await users.get("bob")).claims).toEqual({ project: "acme", "project-admin": "beta" });
    await expect(users.create({ email: "B@X.cz", firstName: "Jiný", lastName: "" })).rejects.toThrow("email already exists");
    expect((await users.findByEmail(" B@x.CZ "))?.id).toBe("bob");

    await users.markEmailVerified("bob");
    expect((await users.get("bob")).emailVerified).toBe(true);
    expect(await users.updateProfile("bob", { email: "Nova@X.cz" })).toMatchObject({ email: "nova@x.cz", emailVerified: false, name: "Bob Novák" });
    await expect(users.setClaims("nobody", { project: "x" })).rejects.toThrow("not found");
  });
});
