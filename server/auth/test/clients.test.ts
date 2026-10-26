import { afterEach, describe, expect, it } from "vitest";
import { osirisClients } from "../src/clients.ts";
import { browser, closeServers, createTestAuth, GATEWAY_SECRET, ISSUER, WEB } from "./helpers.ts";

afterEach(closeServers);

const alice = { id: "alice", firstName: "Alice", lastName: "N", email: "alice@firma.cz", groups: ["osiris-user", "admin"] };
const bob = { id: "bob", firstName: "Bob", lastName: "B", email: "bob@firma.cz", groups: ["osiris-user"] };
const PASSWORD = "správné-heslo-123";

async function setup() {
  const auth = await createTestAuth({ users: [alice, bob] });
  for (const u of ["alice", "bob"]) await auth.auth.credentials.setPassword(u, PASSWORD);
  return auth;
}

/** A browser signed in as `email`, with calls to the provider's own API as its pages make them. */
async function signedIn(auth: Awaited<ReturnType<typeof setup>>, email: string) {
  const b = await browser(auth);
  expect((await b.signIn(email, PASSWORD)).status).toBe(200);
  const api = (path: string, init: RequestInit = {}) =>
    b.request(path, { ...init, headers: { origin: ISSUER, "content-type": "application/json", ...(init.headers as Record<string, string>) } });
  return { ...b, api };
}

describe("registered applications", () => {
  it("lets only members of an app's groups sign in, and its resource server introspect only its tokens", async () => {
    const auth = await setup();
    const admin = await signedIn(auth, alice.email);
    const created = await admin.api("/api/admin/clients", {
      method: "POST",
      body: JSON.stringify({ id: "wiki", name: "Wiki", confidential: true, redirectUris: ["https://wiki.example/callback"], allowedGroups: ["wiki-users"] }),
    });
    expect(created.status).toBe(201);
    const { secret } = await created.json();
    expect(secret).toEqual(expect.any(String));
    // The secret is shown once: the list never carries it.
    expect(JSON.stringify(await (await admin.api("/api/admin/clients")).json())).not.toContain(secret);
    const api = await admin.api("/api/admin/clients", { method: "POST", body: JSON.stringify({ id: "wiki-api", name: "Wiki API", confidential: true, acceptsTokensOf: ["wiki"] }) });
    const apiSecret = (await api.json()).secret as string;

    const b = await signedIn(auth, bob.email);
    const wiki = { client_id: "wiki", redirect_uri: "https://wiki.example/callback" };
    // Bob isn't in wiki-users: the app hears access_denied, even though he's signed in.
    const refused = await b.authorize(wiki);
    expect([refused.origin, refused.searchParams.get("error")]).toEqual(["https://wiki.example", "access_denied"]);

    await auth.users.createGroup("wiki-users", ["bob"]);
    const callback = await b.authorize(wiki);
    const tokens = await b.request("/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${Buffer.from(`wiki:${secret}`).toString("base64")}` },
      body: new URLSearchParams({ grant_type: "authorization_code", code: callback.searchParams.get("code")!, redirect_uri: wiki.redirect_uri, code_verifier: b.verifier }),
    });
    expect(tokens.status).toBe(200);
    const access = ((await tokens.json()) as { access_token: string }).access_token;

    // Its resource server accepts it; Osiris's gateway, which accepts only Osiris's apps, doesn't.
    expect(await (await auth.introspect(access, apiSecret, "wiki-api")).json()).toMatchObject({ active: true, sub: "bob", client_id: "wiki", groups: ["osiris-user", "wiki-users"] });
    expect(await (await auth.introspect(access)).json()).toEqual({ active: false });
    // A new secret ends the old one.
    const rotated = await (await admin.api("/api/admin/clients/wiki-api/secret", { method: "POST" })).json();
    expect((await auth.introspect(access, apiSecret, "wiki-api")).status).toBe(401);
    expect((await (await auth.introspect(access, rotated.secret, "wiki-api")).json()).active).toBe(true);

    // Removing the app ends its tokens.
    expect((await admin.api("/api/admin/clients/wiki", { method: "DELETE" })).status).toBe(204);
    expect((await (await auth.introspect(access, rotated.secret, "wiki-api")).json()).active).toBe(false);
  });

  it("refuses apps that couldn't sign anyone in and duplicate ids", async () => {
    const auth = await setup();
    const admin = await signedIn(auth, alice.email);
    const post = (body: unknown) => admin.api("/api/admin/clients", { method: "POST", body: JSON.stringify(body) });
    expect((await post({ id: "empty", name: "Empty" })).status).toBe(400);
    expect((await post({ id: "bad", name: "Bad", redirectUris: ["not a url"] })).status).toBe(400);
    expect((await post({ id: "osiris-web", name: "Again", redirectUris: ["https://x.example/cb"] })).status).toBe(409);
  });

  it("registers Osiris's apps once and never changes them afterwards", async () => {
    const auth = await setup();
    expect(await auth.auth.clients.ensure(osirisClients([WEB], GATEWAY_SECRET))).toEqual([]);
    await auth.auth.clients.update("osiris-web", { name: "Renamed", redirectUris: [`${WEB}/callback`] });
    await auth.auth.clients.ensure(osirisClients([WEB, "https://other.example"], GATEWAY_SECRET));
    expect((await auth.auth.clients.get("osiris-web"))?.name).toBe("Renamed");
  });
});

describe("administration", () => {
  it("is for the admin group only: the admin API and SCIM from the browser", async () => {
    const auth = await setup();
    const admin = await signedIn(auth, alice.email);
    const member = await signedIn(auth, bob.email);
    expect(await (await admin.api("/api/config")).json()).toMatchObject({ name: "Test", admin: true, user: { id: "alice" } });
    expect(await (await member.api("/api/config")).json()).toMatchObject({ admin: false });

    expect((await member.api("/api/admin/clients")).status).toBe(403);
    expect((await member.api("/scim/v2/Users")).status).toBe(401);
    expect((await (await admin.api("/scim/v2/Users")).json()).totalResults).toBe(2);
    // Changes need the provider's own pages (Origin), not just the cookie.
    const create = (origin: string) =>
      admin.request("/scim/v2/Groups", { method: "POST", headers: { origin, "content-type": "application/scim+json" }, body: JSON.stringify({ displayName: "team" }) });
    expect((await create("https://evil.example")).status).toBe(401);
    expect((await create(ISSUER)).status).toBe(201);

    const made = await (await admin.api("/api/admin/tokens", { method: "POST", body: JSON.stringify({ name: "wiki" }) })).json();
    expect((await auth.app.request("/scim/v2/Users", { headers: { authorization: `Bearer ${made.token}` } })).status).toBe(200);
    expect((await (await admin.api("/api/admin/tokens")).json()).map((t: { name: string }) => t.name)).toEqual(["control", "wiki"]);
    expect((await admin.api("/api/admin/tokens/wiki", { method: "DELETE" })).status).toBe(204);
    expect((await auth.app.request("/scim/v2/Users", { headers: { authorization: `Bearer ${made.token}` } })).status).toBe(401);
  });

  it("lets users change their own profile", async () => {
    const auth = await setup();
    const b = await signedIn(auth, bob.email);
    expect(await (await b.api("/api/me/profile", { method: "PATCH", body: JSON.stringify({ lastName: "Novák" }) })).json()).toMatchObject({ name: "Bob Novák" });
    expect((await b.api("/api/me/picture", { method: "PUT", body: "<svg/>" })).status).toBe(415);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0]);
    expect((await b.api("/api/me/picture", { method: "PUT", body: png })).status).toBe(204);
    expect((await auth.users.get("bob")).picture).toMatch(/^http:\/\/auth\.test\/pictures\/bob\//);
  });
});
