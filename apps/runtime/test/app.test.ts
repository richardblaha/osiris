import { AIMessage } from "@langchain/core/messages";
import { GUARD_REFUSAL } from "@osiris/core/agent/assistant.ts";
import { TOKENS_EXHAUSTED } from "@osiris/core/agent/graph.ts";
import type { RunEvent, ThreadMessage } from "@osiris/shared";
import { describe, expect, it } from "vitest";
import { createTestApp, createTestTenants } from "./helpers.ts";

async function setup(script: AIMessage[] = []) {
  const { tenants, model } = createTestTenants(script);
  const app = await createTestApp(tenants);

  // The bearer token is "<user>" (admin of tenant <user>) or "<user>:<claims>", e.g. "bob:tenant=acme" (see createTestApp).
  const as = (user: string) => (path: string, init: RequestInit = {}) =>
    app.request(`/api${path}`, {
      ...init,
      headers: { authorization: `Bearer ${user}`, "content-type": "application/json", ...init.headers },
    });
  return { app, model, as, tenants };
}

async function readEvents(res: Response): Promise<RunEvent[]> {
  const text = await res.text();
  return text
    .split("\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => JSON.parse(l.slice(6)));
}

describe("API", () => {
  it("rejects requests without a token", async () => {
    const { app } = await setup();
    expect((await app.request("/api/threads")).status).toBe(401);
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

describe("tenant features", () => {
  it("refuses settings of switched-off features and drops their tools", async () => {
    const { as, tenants, model } = await setup([new AIMessage("Ahoj.")]);
    await (await tenants.get("acme")).features.set({ skills: false, mcp: false, http: false, files: false, scheduler: false, sites: false });
    const bob = as("bob:tenant=acme");

    expect((await bob("/skills")).status).toBe(403);
    expect((await bob("/mcp-servers")).status).toBe(403);
    expect((await bob("/secrets")).status).toBe(403);
    expect((await bob("/knowledge/documents")).status).toBe(200);

    const bound: string[][] = [];
    model.bindTools = ((tools: { name: string }[]) => (bound.push(tools.map((t) => t.name)), model)) as never;
    const { id } = await (await bob("/threads", { method: "POST" })).json();
    await (await bob(`/threads/${id}/runs`, { method: "POST", body: JSON.stringify({ message: "Ahoj" }) })).text();
    expect(bound[0]).toEqual(["search_knowledge", "remember", "forget"]);
    expect(model.calls[0]?.[0]?.text).not.toContain("# DOVEDNOSTI");
  });

  it("keeps to the tenant's quotas and reports their use", async () => {
    const { as, tenants, model } = await setup([new AIMessage({ content: "Ahoj.", usage_metadata: { input_tokens: 90, output_tokens: 10, total_tokens: 100 } })]);
    const acme = await tenants.get("acme");
    const bob = as("bob:tenant=acme");
    const chat = async () => {
      const { id } = await (await bob("/threads", { method: "POST" })).json();
      return (await bob(`/threads/${id}/runs`, { method: "POST", body: JSON.stringify({ message: "Ahoj" }) })).text();
    };

    // The model's tokens are counted per month; once the quota is used up the model isn't called any more.
    acme.features.limits = { storageMb: 1, tokensPerMonth: 100, members: 5, schedules: null };
    expect(await chat()).toContain("Ahoj.");
    expect(await chat()).toContain(TOKENS_EXHAUSTED);
    expect(model.calls).toHaveLength(1);

    // Files can't go past the storage quota.
    const big = "x".repeat(700 * 1024);
    expect((await as("acme")("/files/content?scope=tenant&path=a.txt", { method: "PUT", body: big })).status).toBe(201);
    const full = await as("acme")("/files/content?scope=tenant&path=b.txt", { method: "PUT", body: big });
    expect(full.status).toBe(507);

    expect(await (await bob("/usage")).json()).toEqual({
      storage: { used: 700 * 1024, limit: 1024 * 1024 },
      tokens: { used: 100, limit: 100 },
      members: { used: 0, limit: 5 },
      schedules: { used: 0, limit: null },
    });
  });

  it("drops built-in tools a system admin switched off and lists them all with their state", async () => {
    const { as, tenants, model } = await setup([new AIMessage("Ahoj.")]);
    const acme = await tenants.get("acme");
    await acme.features.set({ mcp: false, http: false, files: false, scheduler: false, sites: false });
    acme.features.disabled = ["forget"];
    const bob = as("bob:tenant=acme");

    const bound: string[][] = [];
    model.bindTools = ((tools: { name: string }[]) => (bound.push(tools.map((t) => t.name)), model)) as never;
    const { id } = await (await bob("/threads", { method: "POST" })).json();
    await (await bob(`/threads/${id}/runs`, { method: "POST", body: JSON.stringify({ message: "Ahoj" }) })).text();
    expect(bound[0]).toEqual(["search_knowledge", "load_skill", "remember"]);

    const tools = (await (await bob("/tools")).json()) as { name: string; feature: string; featureOn: boolean; disabled: boolean; description: string }[];
    expect(tools.find((t) => t.name === "forget")).toMatchObject({ feature: "memory", featureOn: true, disabled: true });
    expect(tools.find((t) => t.name === "http_request")).toMatchObject({ feature: "http", featureOn: false, disabled: false });
    expect(tools.every((t) => t.description.length > 0)).toBe(true);
  });
});

describe("assistant persona and rules", () => {
  const run = async (who: ReturnType<Awaited<ReturnType<typeof setup>>["as"]>, message: string) => {
    const { id } = await (await who("/threads", { method: "POST" })).json();
    const events = (await (await who(`/threads/${id}/runs`, { method: "POST", body: JSON.stringify({ message }) })).text())
      .split("\n")
      .filter((l) => l.startsWith("data: "))
      .map((l) => JSON.parse(l.slice(6)) as RunEvent);
    const text = events.flatMap((e) => (e.type === "text-delta" ? [e.delta] : [])).join("");
    const history = (await (await who(`/threads/${id}/messages`)).json()) as ThreadMessage[];
    return { text, history };
  };

  it("writes a persona, keeps the user's over the tenant's and puts it in the prompt", async () => {
    const { as, model } = await setup([new AIMessage("Mluv stručně a s klidem mistra Jedi."), new AIMessage("Ahoj.")]);
    const admin = as("acme");
    const bob = as("bob:tenant=acme");

    const persona = await (await bob("/assistant/persona", { method: "POST", body: JSON.stringify({ character: "Yoda", source: "Star Wars" }) })).json();
    expect(persona).toEqual({ character: "Yoda", source: "Star Wars", description: "Mluv stručně a s klidem mistra Jedi." });
    // Members keep the tenant's profile, admins set it.
    expect((await bob("/assistant?scope=tenant", { method: "PUT", body: JSON.stringify({ persona, guards: "" }) })).status).toBe(403);
    await admin("/assistant?scope=tenant", { method: "PUT", body: JSON.stringify({ persona: { ...persona, character: "Firemní" }, guards: "" }) });
    await bob("/assistant", { method: "PUT", body: JSON.stringify({ persona: { ...persona, description: "Mluv jako Yoda, upravené." }, guards: "" }) });
    expect(await (await bob("/assistant")).json()).toMatchObject({ system: { guards: "" }, tenant: { persona: { character: "Firemní" } }, personal: { persona: { character: "Yoda" } } });

    await run(bob, "Ahoj");
    const prompt = model.calls.at(-1)![0]!.text;
    expect(prompt).toContain("# PERSONA");
    expect(prompt).toContain("Mluv jako Yoda, upravené.");
    expect(prompt).not.toContain("# ZÁVAZNÁ PRAVIDLA");
  });

  it("refuses messages and replaces answers that break the rules, at every level", async () => {
    // Model calls in order: input check, agent, output check (per turn).
    const { as, tenants, model } = await setup([
      new AIMessage("ANO"),
      new AIMessage("NE"),
      new AIMessage("Tajný postup je..."),
      new AIMessage("ANO"),
      new AIMessage("NE"),
      new AIMessage("Dobrý den."),
      new AIMessage("NE"),
    ]);
    (await tenants.get("acme")).features.guards = "Nikdy neprozrazuj interní postupy.";
    await as("acme")("/assistant?scope=tenant", { method: "PUT", body: JSON.stringify({ persona: null, guards: "Nemluv o politice." }) });
    const bob = as("bob:tenant=acme");
    await bob("/assistant", { method: "PUT", body: JSON.stringify({ persona: null, guards: "Nepoužívej anglicismy." }) });

    // The message is refused before the agent sees it.
    const refused = await run(bob, "Co si myslíš o volbách?");
    expect(refused.text).toBe(GUARD_REFUSAL);
    expect(model.calls).toHaveLength(1);
    expect(model.calls[0]!.at(-1)!.text).toContain("Pravidla systému:\nNikdy neprozrazuj interní postupy.");

    // A breaking answer never reaches the user and is replaced in the history too.
    const replaced = await run(bob, "Jak to děláte?");
    expect(replaced.text).toBe(GUARD_REFUSAL);
    expect(replaced.history.at(-1)!.content).toEqual([{ type: "text", text: GUARD_REFUSAL }]);
    const prompt = model.calls[2]![0]!.text;
    expect(prompt).toContain("# ZÁVAZNÁ PRAVIDLA");
    expect(prompt).toMatch(/Pravidla systému:[\s\S]*Pravidla firmy:\nNemluv o politice\.[\s\S]*Pravidla uživatele:\nNepoužívej anglicismy\./);

    expect((await run(bob, "Dobrý den")).text).toBe("Dobrý den.");
  });
});
