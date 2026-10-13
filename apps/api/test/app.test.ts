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

  it("lets only admins change the knowledge base and skills", async () => {
    const { as } = await setup();
    const member = as("bob:tenant-acme");
    const admin = as("alice:tenant-acme-admin");
    const doc = { method: "POST", body: JSON.stringify({ title: "T", content: "obsah" }) };
    const skill = { method: "PUT", body: JSON.stringify({ description: "Revize", instructions: "Postup." }) };

    expect((await member("/knowledge/documents", doc)).status).toBe(403);
    expect((await member("/skills/revize", skill)).status).toBe(403);
    expect((await admin("/skills/revize", skill)).status).toBe(200);
    expect((await admin("/skills/Bad_Name", skill)).status).toBe(400);
    expect(await (await member("/skills")).json()).toContainEqual({ name: "revize", description: "Revize", source: "tenant" });
    expect(await (await member("/skills/revize")).json()).toMatchObject({ instructions: "Postup." });
  });

  it("manages personal and shared memories", async () => {
    const { as } = await setup();
    const member = as("bob:tenant-acme");
    const admin = as("alice:tenant-acme-admin");
    const post = (content: string, shared: boolean) => ({ method: "POST", body: JSON.stringify({ content, shared }) });

    expect((await member("/memories", post("Firma", true))).status).toBe(403);
    const shared = await (await admin("/memories", post("Neplátce DPH", true))).json();
    await member("/memories", post("Tyká", false));
    await admin("/memories", post("Alice osobní", false));

    expect((await (await member("/memories")).json()).map((m: { content: string }) => m.content).sort()).toEqual(["Neplátce DPH", "Tyká"]);
    expect((await member(`/memories/${shared.id}`, { method: "DELETE" })).status).toBe(404);
    expect((await admin(`/memories/${shared.id}`, { method: "DELETE" })).status).toBe(204);
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
