import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AIMessage } from "@langchain/core/messages";
import type { RunEvent, ThreadMessage } from "@osiris/shared";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { createDevVerifier } from "../src/auth/oidc.ts";
import { createTestTenants } from "./helpers.ts";

async function setup(script: AIMessage[] = []) {
  const { tenants, model } = createTestTenants(script);
  const app = createApp({ verifier: createDevVerifier(), tenants, corsOrigin: "*" });

  // With the dev verifier, the bearer token is "<user>" (admin of tenant <user>) or "<user>:<groups>".
  const as = (user: string) => (path: string, init: RequestInit = {}) =>
    app.request(`/api${path}`, {
      ...init,
      headers: { authorization: `Bearer ${user}`, "content-type": "application/json", ...init.headers },
    });
  return { app, model, as };
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

  it("takes the user's tenants and roles from PocketID groups", async () => {
    const { as } = await setup();
    const me = await (await as("alice:tenant-acme,tenant-beta-admin,other")("/me")).json();
    expect(me.user).toEqual({ id: "dev:alice", email: "alice@dev.local", name: "alice", phone: null });
    expect(me.tenants).toEqual([
      { id: "acme", name: "acme", role: "member" },
      { id: "beta", name: "beta", role: "admin" },
    ]);
  });

  it("refuses users without a tenant group", async () => {
    const { as } = await setup();
    expect((await as("alice:other")("/me")).status).toBe(403);
  });

  it("requires choosing a tenant when the user has several", async () => {
    const { as } = await setup();
    const alice = as("alice:tenant-acme,tenant-beta");
    expect((await alice("/threads")).status).toBe(400);
    expect((await alice("/threads", { headers: { "x-tenant-id": "beta" } })).status).toBe(200);
  });

  it("rejects a tenant the user is not a member of", async () => {
    const { as } = await setup();
    expect((await as("alice")("/threads", { headers: { "x-tenant-id": "bob" } })).status).toBe(403);
  });

  it("hides one user's threads from another in the same tenant", async () => {
    const { as } = await setup();
    const { id } = await (await as("alice:tenant-acme")("/threads", { method: "POST" })).json();
    expect((await as("bob:tenant-acme")(`/threads/${id}/messages`)).status).toBe(404);
    expect(await (await as("bob:tenant-acme")("/threads")).json()).toEqual([]);
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
    const member = as("bob:tenant-acme");
    const admin = as("alice:tenant-acme-admin");
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
    expect((await member("/skills/revize?scope=tenant", { method: "DELETE" })).status).toBe(403);
    expect((await member("/skills/revize", { method: "DELETE" })).status).toBe(204);
    expect((await member("/skills/revize?scope=bogus", { method: "DELETE" })).status).toBe(400);
  });

  it("keeps personal documents to their owner, in the list and in search", async () => {
    const { as } = await setup([
      new AIMessage({ content: "", tool_calls: [{ id: "k", name: "search_knowledge", args: { query: "kód od garáže" } }] }),
      new AIMessage("Nevím."),
    ]);
    const bob = as("bob:tenant-acme");
    const alice = as("alice:tenant-acme-admin");
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
    const bob = as("bob:tenant-acme");
    expect(await (await bob("/settings")).json()).toEqual({ address: "auto", language: "auto", signature: "", instructions: "" });

    const profile = { address: "vy", language: "sk", signature: "Bob Novák, elektrikář", instructions: "Ceny uváděj s DPH." };
    expect((await bob("/settings", { method: "PUT", body: JSON.stringify({ ...profile, address: "onikání" }) })).status).toBe(400);
    expect((await bob("/settings", { method: "PUT", body: JSON.stringify(profile) })).status).toBe(200);
    expect(await (await bob("/settings")).json()).toEqual(profile);
    expect(await (await as("alice:tenant-acme")("/settings")).json()).toMatchObject({ address: "auto" });

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
    const member = as("bob:tenant-acme");
    const admin = as("alice:tenant-acme-admin");
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
