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

  it("lets admins manage the tenant's settings and refuses the old personal scope", async () => {
    const { as } = await setup();
    const member = as("bob:tenant=acme");
    const admin = as("alice:tenant-admin=acme");
    const skill = (body: object = {}) => ({ method: "PUT", body: JSON.stringify({ description: "Revize", instructions: "Postup.", ...body }) });

    expect((await member("/skills/revize", skill())).status).toBe(403);
    expect((await admin("/skills/Bad_Name", skill())).status).toBe(400);
    expect((await admin("/skills/revize", skill({ scope: "personal" }))).status).toBe(400);
    expect((await admin("/skills/revize", skill())).status).toBe(200);
    expect(await (await member("/skills")).json()).toContainEqual({ name: "revize", description: "Revize", source: "tenant" });
    expect(await (await member("/skills/revize")).json()).toMatchObject({ instructions: "Postup.", source: "tenant" });
    expect((await member("/skills/revize", { method: "DELETE" })).status).toBe(403);
    expect((await admin("/skills/revize?scope=personal", { method: "DELETE" })).status).toBe(400);
    expect((await admin("/skills/revize", { method: "DELETE" })).status).toBe(204);
  });

  it("keeps one knowledge base for the tenant, which every member adds to and searches", async () => {
    const { as } = await setup([
      new AIMessage({ content: "", tool_calls: [{ id: "k", name: "search_knowledge", args: { query: "kód od garáže" } }] }),
      new AIMessage("4321."),
    ]);
    const bob = as("bob:tenant=acme");
    const alice = as("alice:tenant-admin=acme");
    const add = (title: string, content: string) => ({ method: "POST", body: JSON.stringify({ title, content }) });

    const garage = await (await bob("/knowledge/documents", add("Garáž", "Kód od garáže je 4321."))).json();
    await alice("/knowledge/documents", add("Ceník", "Hodinová sazba 650 Kč."));
    for (const who of [bob, alice]) {
      expect((await (await who("/knowledge/documents")).json()).map((d: { title: string; scope: string }) => [d.title, d.scope])).toEqual([
        ["Ceník", "tenant"],
        ["Garáž", "tenant"],
      ]);
    }

    const { id } = await (await alice("/threads", { method: "POST" })).json();
    const events = await readEvents(await alice(`/threads/${id}/runs`, { method: "POST", body: JSON.stringify({ message: "Kód?" }) }));
    const result = events.find((e) => e.type === "tool-result");
    expect(result?.type === "tool-result" && result.result).toContain("4321");

    expect((await alice(`/knowledge/documents/${garage.id}`, { method: "DELETE" })).status).toBe(204);
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

  it("keeps one memory for the tenant, which every member manages", async () => {
    const { as } = await setup();
    const member = as("bob:tenant=acme");
    const admin = as("alice:tenant-admin=acme");
    const post = (content: string) => ({ method: "POST", body: JSON.stringify({ content }) });

    const vat = await (await member("/memories", post("Neplátce DPH"))).json();
    await admin("/memories", post("Sídlo Brno"));
    expect((await (await admin("/memories")).json()).map((m: { content: string; scope: string }) => [m.content, m.scope]).sort()).toEqual([
      ["Neplátce DPH", "tenant"],
      ["Sídlo Brno", "tenant"],
    ]);
    expect((await member(`/memories/${vat.id}?scope=personal`, { method: "DELETE" })).status).toBe(400);
    expect((await admin(`/memories/${vat.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await member("/memories", { method: "POST", body: JSON.stringify({ content: "x", scope: "personal" }) })).status).toBe(400);
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
    expect(bound[0]).toEqual(["search_knowledge", "save_knowledge", "remember", "forget"]);
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
    expect(bound[0]).toEqual(["search_knowledge", "save_knowledge", "load_skill", "remember"]);

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

  it("writes a persona, the user's own only, and puts it in the prompt", async () => {
    const { as, model } = await setup([new AIMessage("Mluv stručně a s klidem mistra Jedi."), new AIMessage("Ahoj.")]);
    const admin = as("acme");
    const bob = as("bob:tenant=acme");

    const persona = await (await bob("/assistant/persona", { method: "POST", body: JSON.stringify({ character: "Yoda", source: "Star Wars" }) })).json();
    expect(persona).toEqual({ character: "Yoda", source: "Star Wars", description: "Mluv stručně a s klidem mistra Jedi." });
    // Personalization is the user's: there is no tenant persona.
    expect((await admin("/assistant?scope=tenant", { method: "PUT", body: JSON.stringify({ persona }) })).status).toBe(400);
    await bob("/assistant?scope=personal", { method: "PUT", body: JSON.stringify({ persona: { ...persona, description: "Mluv jako Yoda, upravené." } }) });
    expect(await (await bob("/assistant")).json()).toEqual({ personal: { persona: { ...persona, description: "Mluv jako Yoda, upravené." } } });
    expect(await (await admin("/assistant")).json()).toEqual({ personal: { persona: null } });

    await run(bob, "Ahoj");
    const prompt = model.calls.at(-1)![0]!.text;
    expect(prompt).toContain("# PERSONA");
    expect(prompt).toContain("Mluv jako Yoda, upravené.");
    expect(prompt).not.toContain("# ZÁVAZNÁ PRAVIDLA");
  });

  it("refuses messages and replaces answers that break the system's and the tenant's rules", async () => {
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
    (await tenants.get("acme")).features.guards = [{ name: "postupy", description: "", rule: "Nikdy neprozrazuj interní postupy." }];
    const admin = as("acme");
    const bob = as("bob:tenant=acme");
    const put = (who: typeof bob, path: string, rule: string) => who(`/guards/${path}`, { method: "PUT", body: JSON.stringify({ description: "", rule }) });
    // Tenant guards are the admins'; each user has their own.
    expect((await put(bob, "tenant/politika", "Nemluv o politice.")).status).toBe(403);
    expect((await put(admin, "tenant/politika", "Nemluv o politice.")).status).toBe(200);
    expect((await put(bob, "user/cestina", "Nepoužívej anglicismy.")).status).toBe(200);
    expect((await put(bob, "tenant/Spatne", "x")).status).toBe(403);
    expect((await put(admin, "tenant/Spatne", "x")).status).toBe(400);
    expect(await (await bob("/guards")).json()).toEqual({
      system: [{ name: "postupy", description: "", rule: "Nikdy neprozrazuj interní postupy." }],
      tenant: [{ name: "politika", description: "", rule: "Nemluv o politice." }],
      user: [{ name: "cestina", description: "", rule: "Nepoužívej anglicismy." }],
    });
    expect((await (await as("carol:tenant=acme")("/guards")).json()).user).toEqual([]);
    // They are files under guards/, which members can't change in Soubory, and the agent not at all.
    const acme = await tenants.get("acme");
    expect((await acme.files.read({ scope: "tenant" }, "guards/politika.md")).data.toString()).toContain("Nemluv o politice.");
    expect((await bob("/files?scope=tenant&path=guards/politika.md", { method: "DELETE" })).status).toBe(403);
    const writeFile = acme.builtinTools.map(([, t]) => t).find((t) => t.name === "write_file")!;
    const config = { configurable: { thread_id: "t", tenant_id: "acme", user_id: "acme", role: "admin", channel: "web" } };
    expect(await writeFile.invoke({ scope: "tenant", path: "guards/politika.md", content: "nic", overwrite: true }, config)).toContain("Sem zapisovat nelze");

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
