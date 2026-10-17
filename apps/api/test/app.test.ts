import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AIMessage } from "@langchain/core/messages";
import type { RunEvent, ThreadMessage } from "@osiris/shared";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { createDevVerifier } from "../src/auth/oidc.ts";
import { createTestDirectory, createTestTenants } from "./helpers.ts";

async function setup(script: AIMessage[] = []) {
  const { tenants, model } = createTestTenants(script);
  const { directory, users } = await createTestDirectory(tenants, [{ id: "acme", name: "ACME s.r.o." }, { id: "beta" }]);
  const app = createApp({ verifier: createDevVerifier(), tenants, directory, corsOrigin: "*" });

  // With the dev verifier, the bearer token is "<user>" (admin of tenant <user>) or "<user>:<claims>", e.g. "bob:tenant=acme".
  const as = (user: string) => (path: string, init: RequestInit = {}) =>
    app.request(`/api${path}`, {
      ...init,
      headers: { authorization: `Bearer ${user}`, "content-type": "application/json", ...init.headers },
    });
  return { app, model, as, tenants, directory, users };
}

async function readEvents(res: Response): Promise<RunEvent[]> {
  const text = await res.text();
  return text
    .split("\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => JSON.parse(l.slice(6)));
}

describe("web hosting", () => {
  it("serves the built app, its runtime config and an SPA fallback", async () => {
    const dir = mkdtempSync(join(tmpdir(), "osiris-web-"));
    writeFileSync(join(dir, "index.html"), "<!doctype html>app");
    const { tenants } = createTestTenants();
    const app = createApp({
      verifier: createDevVerifier(),
      tenants,
      directory: (await createTestDirectory(tenants)).directory,
      corsOrigin: "*",
      web: { dir, oidcAuthority: "https://auth.example.cz", oidcClientId: "client-1" },
    });

    const config = await (await app.request("/config.js")).text();
    expect(config).toContain('"oidcClientId":"client-1"');
    expect(await (await app.request("/callback?code=x")).text()).toBe("<!doctype html>app");
    expect((await app.request("/api/me")).status).toBe(401);
  });
});

describe("API", () => {
  it("rejects requests without a token", async () => {
    const { app } = await setup();
    expect((await app.request("/api/me")).status).toBe(401);
  });

  it("takes the user's tenants and roles from PocketID claims", async () => {
    const { as } = await setup();
    const me = await (await as("alice:tenant=acme&tenant-admin=beta")("/me")).json();
    expect(me.user).toEqual({ id: "dev:alice", email: "alice@dev.local", name: "alice", phone: null, picture: null });
    expect(me.tenants).toEqual([
      { id: "acme", name: "ACME s.r.o.", role: "member" },
      { id: "beta", name: "beta", role: "admin" },
    ]);
  });

  it("refuses users without the Osiris role or a tenant", async () => {
    const { as } = await setup();
    const refused = await as("alice:tenant-admin=&role=osiris-user")("/me");
    expect(refused.status).toBe(403);
    // Says who is signed in and with which claims, so the account can be fixed in PocketID.
    expect(await refused.json()).toEqual({
      error: "User is not assigned to any tenant (claim tenant or tenant-admin)",
      user: { sub: "dev:alice", name: "alice", email: "alice@dev.local", role: ["osiris-user"], tenant: [], "tenant-admin": [] },
    });
    expect((await as("alice:")("/me")).status).toBe(403);
    expect((await as("alice:tenant=acme&role=")("/me")).status).toBe(403);
    expect((await as("alice:tenant=acme&role=other")("/me")).status).toBe(403);
    expect((await as("alice:tenant=acme&role=osiris-user")("/me")).status).toBe(200);
  });

  it("requires choosing a tenant when the user has several", async () => {
    const { as } = await setup();
    const alice = as("alice:tenant=acme,beta");
    expect((await alice("/threads")).status).toBe(400);
    expect((await alice("/threads", { headers: { "x-tenant-id": "beta" } })).status).toBe(200);
  });

  it("rejects a tenant the user is not a member of", async () => {
    const { as } = await setup();
    expect((await as("alice")("/threads", { headers: { "x-tenant-id": "bob" } })).status).toBe(403);
  });

  it("hides one user's threads from another in the same tenant", async () => {
    const { as } = await setup();
    const { id } = await (await as("alice:tenant=acme")("/threads", { method: "POST" })).json();
    expect((await as("bob:tenant=acme")(`/threads/${id}/messages`)).status).toBe(404);
    expect(await (await as("bob:tenant=acme")("/threads")).json()).toEqual([]);
  });

  it("streams a run with a tool call and persists the conversation", async () => {
    const { as, model } = await setup([
      new AIMessage({ content: "", tool_calls: [{ id: "call_1", name: "search_knowledge", args: { query: "sazba" } }] }),
      new AIMessage("Sazba je 650 Kč/h."),
    ]);
    const alice = as("alice");
    await alice("/knowledge/documents", {
      method: "POST",
      body: JSON.stringify({ title: "Ceník", content: "Hodinová sazba je 650 Kč." }),
    });
    const { id } = await (await alice("/threads", { method: "POST" })).json();

    const events = await readEvents(await alice(`/threads/${id}/runs`, { method: "POST", body: JSON.stringify({ message: "Jaká je sazba?" }) }));

    expect(events).toContainEqual({ type: "tool-call", toolCallId: "call_1", toolName: "search_knowledge", args: { query: "sazba" } });
    const result = events.find((e) => e.type === "tool-result");
    expect(result?.type === "tool-result" && result.result).toContain("650 Kč");
    expect(events.filter((e) => e.type === "text-delta").map((e) => e.type === "text-delta" && e.delta).join("")).toBe("Sazba je 650 Kč/h.");
    expect(events.at(-1)).toEqual({ type: "done" });
    expect(model.calls[0]?.[0]?.text).toContain("webového chatu");

    const history: ThreadMessage[] = await (await alice(`/threads/${id}/messages`)).json();
    expect(history.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(history[1]?.content).toEqual([
      { type: "tool-call", toolCallId: "call_1", toolName: "search_knowledge", args: { query: "sazba" }, result: expect.stringContaining("650 Kč") },
      { type: "text", text: "Sazba je 650 Kč/h." },
    ]);

    const [thread] = await (await alice("/threads")).json();
    expect(thread.title).toBe("Jaká je sazba?");
  });

  it("searches only the caller's tenant from inside the agent", async () => {
    const { as } = await setup([
      new AIMessage({ content: "", tool_calls: [{ id: "c", name: "search_knowledge", args: { query: "heslo alarmu" } }] }),
      new AIMessage("Nevím."),
    ]);
    await as("bob")("/knowledge/documents", { method: "POST", body: JSON.stringify({ title: "Bob", content: "Heslo alarmu je 1234." }) });
    const alice = as("alice");
    const { id } = await (await alice("/threads", { method: "POST" })).json();

    const events = await readEvents(await alice(`/threads/${id}/runs`, { method: "POST", body: JSON.stringify({ message: "Jaké je heslo?" }) }));
    expect(events).toContainEqual({ type: "tool-result", toolCallId: "c", result: "Nic nenalezeno." });
  });

  it("lets members change personal settings but only admins tenant-wide ones", async () => {
    const { as } = await setup();
    const member = as("bob:tenant=acme");
    const admin = as("alice:tenant-admin=acme");
    const post = (body: object) => ({ method: "POST", body: JSON.stringify({ title: "T", content: "obsah", ...body }) });
    const skill = (body: object) => ({ method: "PUT", body: JSON.stringify({ description: "Revize", instructions: "Postup.", ...body }) });

    expect((await member("/knowledge/documents", post({ scope: "tenant" }))).status).toBe(403);
    expect((await member("/skills/revize", skill({ scope: "tenant" }))).status).toBe(403);
    expect((await admin("/skills/Bad_Name", skill({ scope: "tenant" }))).status).toBe(400);
    expect((await admin("/skills/revize", skill({ scope: "tenant" }))).status).toBe(200);
    expect((await member("/skills/revize", skill({ instructions: "Můj postup." }))).status).toBe(200);

    expect(await (await member("/skills")).json()).toContainEqual({ name: "revize", description: "Revize", source: "personal" });
    expect(await (await member("/skills/revize")).json()).toMatchObject({ instructions: "Můj postup.", source: "personal" });
    expect(await (await admin("/skills/revize")).json()).toMatchObject({ instructions: "Postup.", source: "tenant" });
    expect(await (await member("/skills?scope=tenant")).json()).toContainEqual({ name: "revize", description: "Revize", source: "tenant" });
    expect(await (await member("/skills/revize?scope=tenant")).json()).toMatchObject({ instructions: "Postup.", source: "tenant" });
    expect((await member("/skills/revize?scope=tenant", { method: "DELETE" })).status).toBe(403);
    expect((await member("/skills/revize", { method: "DELETE" })).status).toBe(204);
    expect((await member("/skills/revize?scope=bogus", { method: "DELETE" })).status).toBe(400);
  });

  it("keeps personal documents to their owner, in the list and in search", async () => {
    const { as } = await setup([
      new AIMessage({ content: "", tool_calls: [{ id: "k", name: "search_knowledge", args: { query: "kód od garáže" } }] }),
      new AIMessage("Nevím."),
    ]);
    const bob = as("bob:tenant=acme");
    const alice = as("alice:tenant-admin=acme");
    const add = (title: string, content: string, scope: string) =>
      ({ method: "POST", body: JSON.stringify({ title, content, scope }) });

    const mine = await (await bob("/knowledge/documents", add("Garáž", "Kód od garáže je 4321.", "personal"))).json();
    await alice("/knowledge/documents", add("Ceník", "Hodinová sazba 650 Kč.", "tenant"));

    expect((await (await bob("/knowledge/documents")).json()).map((d: { title: string; scope: string }) => [d.title, d.scope])).toEqual([
      ["Ceník", "tenant"],
      ["Garáž", "personal"],
    ]);
    expect((await (await alice("/knowledge/documents")).json()).map((d: { title: string }) => d.title)).toEqual(["Ceník"]);

    const { id } = await (await alice("/threads", { method: "POST" })).json();
    const events = await readEvents(await alice(`/threads/${id}/runs`, { method: "POST", body: JSON.stringify({ message: "Kód?" }) }));
    const result = events.find((e) => e.type === "tool-result");
    expect(result?.type === "tool-result" && result.result).not.toContain("4321");

    expect((await alice(`/knowledge/documents/${mine.id}?scope=personal`, { method: "DELETE" })).status).toBe(404);
    expect((await bob(`/knowledge/documents/${mine.id}?scope=personal`, { method: "DELETE" })).status).toBe(204);
  });

  it("stores the user's profile and puts it into the system prompt", async () => {
    const { as, model } = await setup([new AIMessage("Dobrý den.")]);
    const bob = as("bob:tenant=acme");
    expect(await (await bob("/settings")).json()).toEqual({ address: "auto", language: "auto", signature: "", instructions: "" });

    const profile = { address: "vy", language: "sk", signature: "Bob Novák, elektrikář", instructions: "Ceny uváděj s DPH." };
    expect((await bob("/settings", { method: "PUT", body: JSON.stringify({ ...profile, address: "onikání" }) })).status).toBe(400);
    expect((await bob("/settings", { method: "PUT", body: JSON.stringify(profile) })).status).toBe(200);
    expect(await (await bob("/settings")).json()).toEqual(profile);
    expect(await (await as("alice:tenant=acme")("/settings")).json()).toMatchObject({ address: "auto" });

    const { id } = await (await bob("/threads", { method: "POST" })).json();
    await (await bob(`/threads/${id}/runs`, { method: "POST", body: JSON.stringify({ message: "Ahoj" }) })).text();
    const system = model.calls[0]?.[0]?.text ?? "";
    expect(system).toContain("Jméno uživatele: bob");
    expect(system).toContain("Uživateli vykej.");
    expect(system).toContain("Odpovídej slovensky.");
    expect(system).toContain("Bob Novák, elektrikář");
    expect(system).toMatch(/pokud nejsou v rozporu s pravidly výše\):\nCeny uváděj s DPH\./);
  });

  it("manages personal and shared memories", async () => {
    const { as } = await setup();
    const member = as("bob:tenant=acme");
    const admin = as("alice:tenant-admin=acme");
    const post = (content: string, scope: string) => ({ method: "POST", body: JSON.stringify({ content, scope }) });

    expect((await member("/memories", post("Firma", "tenant"))).status).toBe(403);
    const shared = await (await admin("/memories", post("Neplátce DPH", "tenant"))).json();
    const mine = await (await member("/memories", post("Tyká", "personal"))).json();
    await admin("/memories", post("Alice osobní", "personal"));

    expect((await (await member("/memories")).json()).map((m: { content: string; scope: string }) => [m.content, m.scope]).sort()).toEqual([
      ["Neplátce DPH", "tenant"],
      ["Tyká", "personal"],
    ]);
    expect((await member(`/memories/${shared.id}?scope=tenant`, { method: "DELETE" })).status).toBe(403);
    expect((await member(`/memories/${shared.id}`, { method: "DELETE" })).status).toBe(404);
    expect((await admin(`/memories/${mine.id}`, { method: "DELETE" })).status).toBe(404);
    expect((await member(`/memories/${mine.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await admin(`/memories/${shared.id}?scope=tenant`, { method: "DELETE" })).status).toBe(204);
  });

  it("deletes a thread and its checkpoints", async () => {
    const { as } = await setup([new AIMessage("Ahoj")]);
    const alice = as("alice");
    const { id } = await (await alice("/threads", { method: "POST" })).json();
    await (await alice(`/threads/${id}/runs`, { method: "POST", body: JSON.stringify({ message: "ahoj" }) })).text();

    expect((await alice(`/threads/${id}`, { method: "DELETE" })).status).toBe(204);
    expect((await alice(`/threads/${id}/messages`)).status).toBe(404);
  });
});

describe("tenant administration", () => {
  it("gives osiris-admin every tenant as admin, with display names", async () => {
    const { as } = await setup();
    const me = await (await as("root:role=osiris-admin")("/me")).json();
    expect(me.systemAdmin).toBe(true);
    expect(me.tenants).toEqual([
      { id: "acme", name: "ACME s.r.o.", role: "admin" },
      { id: "beta", name: "beta", role: "admin" },
    ]);
    expect((await as("root:role=osiris-admin")("/threads", { headers: { "x-tenant-id": "beta" } })).status).toBe(200);
    // A tenant that doesn't exist is not opened (and so not created).
    expect((await as("root:role=osiris-admin")("/threads", { headers: { "x-tenant-id": "nope" } })).status).toBe(403);
    expect((await as("bob:tenant=acme")("/me")).status).toBe(200);
    expect((await (await as("bob:tenant=acme")("/me")).json()).systemAdmin).toBe(false);
  });

  it("lets only osiris-admin create, configure and remove tenants", async () => {
    const { as, users } = await setup();
    const root = as("root:role=osiris-admin");
    const json = (body: object) => ({ body: JSON.stringify(body) });

    expect((await as("alice:tenant-admin=acme")("/admin/tenants")).status).toBe(403);
    expect((await root("/admin/tenants", { method: "POST", ...json({ id: "Bad Slug", name: "X" }) })).status).toBe(400);
    expect((await root("/admin/tenants", { method: "POST", ...json({ id: "acme", name: "Dup" }) })).status).toBe(409);
    const created = await root("/admin/tenants", { method: "POST", ...json({ id: "novak", name: "Novák stavby", features: { mcp: false } }) });
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ id: "novak", name: "Novák stavby", members: 0 });

    users.users.push({ id: "dev:bob", name: "Bob", email: null, disabled: false, claims: { phone_number: "+420777123456", tenant: "acme" } });
    expect((await root("/admin/tenants/novak/members/dev:bob", { method: "PUT", ...json({ role: "admin" }) })).status).toBe(204);
    // Membership is written to the user's claims, keeping the others; a new member also gets the Osiris role.
    expect(users.users[0]!.claims).toEqual({ phone_number: "+420777123456", tenant: "acme", "tenant-admin": "novak", role: "osiris-user" });
    expect((await root("/admin/tenants/novak/members/nobody", { method: "PUT", ...json({ role: "admin" }) })).status).toBe(404);
    expect((await root("/admin/tenants/novak", { method: "PATCH", ...json({ name: "Novák a syn", features: { http: false } }) })).status).toBe(204);
    const detail = await (await root("/admin/tenants/novak")).json();
    expect(detail).toMatchObject({ id: "novak", name: "Novák a syn", memberList: [{ userId: "dev:bob", role: "admin" }] });
    expect(detail.features).toMatchObject({ knowledge: true, mcp: false, http: false });

    expect((await root("/admin/tenants/nope")).status).toBe(404);
    expect((await root("/admin/tenants/novak", { method: "DELETE" })).status).toBe(204);
    // Removing the tenant takes it out of everyone's claims.
    expect(users.users[0]!.claims).toEqual({ phone_number: "+420777123456", tenant: "acme", role: "osiris-user" });
    expect((await (await root("/admin/tenants")).json()).map((t: { id: string }) => t.id)).toEqual(["acme", "beta"]);
  });

  it("refuses settings of switched-off features and drops their tools", async () => {
    const { as, tenants, model } = await setup([new AIMessage("Ahoj.")]);
    await (await tenants.get("acme")).features.set({ skills: false, mcp: false, http: false });
    const bob = as("bob:tenant=acme");

    expect((await bob("/skills")).status).toBe(403);
    expect((await bob("/mcp-servers")).status).toBe(403);
    expect((await bob("/secrets")).status).toBe(403);
    expect((await bob("/knowledge/documents")).status).toBe(200);
    expect(await (await bob("/tenant")).json()).toMatchObject({ id: "acme", name: "ACME s.r.o.", role: "member", features: { skills: false, knowledge: true } });

    const bound: string[][] = [];
    model.bindTools = ((tools: { name: string }[]) => (bound.push(tools.map((t) => t.name)), model)) as never;
    const { id } = await (await bob("/threads", { method: "POST" })).json();
    await (await bob(`/threads/${id}/runs`, { method: "POST", body: JSON.stringify({ message: "Ahoj" }) })).text();
    expect(bound[0]).toEqual(["search_knowledge", "remember", "forget"]);
    expect(model.calls[0]?.[0]?.text).not.toContain("# DOVEDNOSTI");
  });
});
