import { ChatGenerationChunk } from "@langchain/core/outputs";
import { AIMessage, AIMessageChunk } from "@langchain/core/messages";
import { GUARD_REFUSAL } from "@osiris/core/agent/assistant.ts";
import { translate } from "@osiris/platform/i18n.ts";
import { TOKENS_EXHAUSTED, USER_TOKENS_EXHAUSTED } from "@osiris/core/agent/graph.ts";
import type { RunEvent, ThreadMessage } from "@osiris/shared";
import { NO_QUOTAS } from "@osiris/shared";
import { describe, expect, it } from "vitest";
import { createTestApp, createTestProjects } from "./helpers.ts";

async function setup(script: AIMessage[] = []) {
  const { projects, model } = createTestProjects(script);
  const app = await createTestApp(projects);

  // The bearer token is "<user>" (admin of project <user>) or "<user>:<claims>", e.g. "bob:project=acme" (see createTestApp).
  const as = (user: string) => (path: string, init: RequestInit = {}) =>
    app.request(`/api${path}`, {
      ...init,
      headers: { authorization: `Bearer ${user}`, "content-type": "application/json", ...init.headers },
    });
  return { app, model, as, projects };
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

  it("requires choosing a project when the user has several", async () => {
    const { as } = await setup();
    const alice = as("alice:project=acme,beta");
    expect((await alice("/threads")).status).toBe(400);
    expect((await alice("/threads", { headers: { "x-project-id": "beta" } })).status).toBe(200);
  });

  it("rejects a project the user is not a member of", async () => {
    const { as } = await setup();
    expect((await as("alice")("/threads", { headers: { "x-project-id": "bob" } })).status).toBe(403);
  });

  it("hides one user's threads from another in the same project", async () => {
    const { as } = await setup();
    const { id } = await (await as("alice:project=acme")("/threads", { method: "POST" })).json();
    expect((await as("bob:project=acme")(`/threads/${id}/messages`)).status).toBe(404);
    expect(await (await as("bob:project=acme")("/threads")).json()).toEqual([]);
  });

  it("announces a tool call as soon as the model starts writing it", async () => {
    const { as, model } = await setup();
    // A model that streams its tool call in pieces (name first, arguments later), as real ones do.
    let turn = 0;
    Object.assign(model, {
      async *_streamResponseChunks() {
        const chunks =
          turn++ === 0
            ? [
                new AIMessageChunk({ content: "", tool_call_chunks: [{ type: "tool_call_chunk", id: "call_1", name: "list_files", args: "", index: 0 }] }),
                new AIMessageChunk({ content: "", tool_call_chunks: [{ type: "tool_call_chunk", args: '{"scope":"project"}', index: 0 }] }),
              ]
            : [new AIMessageChunk("Hotovo.")];
        for (const message of chunks) yield new ChatGenerationChunk({ text: message.text, message });
      },
    });
    const alice = as("alice");
    const { id } = await (await alice("/threads", { method: "POST" })).json();
    const events = await readEvents(await alice(`/threads/${id}/runs`, { method: "POST", body: JSON.stringify({ message: "Co máme v souborech?" }) }));

    const types = events.map((e) => e.type);
    expect(events).toContainEqual({ type: "tool-call-start", toolCallId: "call_1", toolName: "list_files" });
    expect(types.indexOf("tool-call-start")).toBeLessThan(types.indexOf("tool-call"));
    expect(events.filter((e) => e.type === "tool-call-start")).toHaveLength(1);
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
    // What it's doing, step by step: the model, the tool, the model again.
    expect(events.flatMap((e) => (e.type === "status" ? [e.status] : []))).toEqual(["thinking", "tools", "thinking"]);
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

  it("searches only the caller's project from inside the agent", async () => {
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

  it("lets admins manage the project's skills and everyone keep their own over them", async () => {
    const { as } = await setup();
    const member = as("bob:project=acme");
    const admin = as("alice:project-admin=acme");
    const skill = (body: object = {}) => ({ method: "PUT", body: JSON.stringify({ description: "Revize", instructions: "Postup.", scope: "project", ...body }) });

    expect((await member("/skills/revize", skill())).status).toBe(403);
    expect((await admin("/skills/Bad_Name", skill())).status).toBe(400);
    expect((await admin("/skills/revize", skill())).status).toBe(200);
    expect(await (await member("/skills")).json()).toContainEqual({ name: "revize", description: "Revize", source: "project" });
    expect(await (await member("/skills/revize")).json()).toMatchObject({ instructions: "Postup.", source: "project" });
    expect((await member("/skills/revize?scope=project", { method: "DELETE" })).status).toBe(403);

    // Bob's own copy replaces the project's for him only.
    expect((await member("/skills/revize", skill({ scope: "personal", instructions: "Můj postup." }))).status).toBe(200);
    expect((await (await member("/skills")).json()).filter((s: { name: string }) => s.name === "revize")).toEqual([
      { name: "revize", description: "Revize", source: "personal" },
      { name: "revize", description: "Revize", source: "project", overridden: true },
    ]);
    expect(await (await member("/skills/revize")).json()).toMatchObject({ instructions: "Můj postup.", source: "personal" });
    expect(await (await member("/skills/revize?source=project")).json()).toMatchObject({ instructions: "Postup.", source: "project" });
    expect(await (await admin("/skills/revize")).json()).toMatchObject({ instructions: "Postup.", source: "project" });
    expect((await member("/skills/revize?scope=personal", { method: "DELETE" })).status).toBe(204);
    expect(await (await member("/skills/revize")).json()).toMatchObject({ source: "project" });
    expect((await admin("/skills/revize?scope=project", { method: "DELETE" })).status).toBe(204);
    expect((await admin("/skills/revize?scope=everyone", { method: "DELETE" })).status).toBe(400);
  });

  it("searches the project's knowledge base and the caller's own documents, which replace the project's of the same id", async () => {
    const { as } = await setup([
      new AIMessage({ content: "", tool_calls: [{ id: "k", name: "search_knowledge", args: { query: "kód od garáže" } }] }),
      new AIMessage("4321."),
    ]);
    const bob = as("bob:project=acme");
    const alice = as("alice:project-admin=acme");
    const add = (title: string, content: string, body: object = {}) => ({ method: "POST", body: JSON.stringify({ title, content, ...body }) });

    expect((await bob("/knowledge/documents", add("Ceník", "x", { scope: "project" }))).status).toBe(403);
    const garage = await (await bob("/knowledge/documents", add("Garáž", "Kód od garáže je 4321."))).json();
    expect(garage).toMatchObject({ id: "garaz.md", scope: "personal" });
    const price = await (await alice("/knowledge/documents", add("Ceník", "Hodinová sazba 650 Kč.", { scope: "project" }))).json();
    expect((await bob("/knowledge/documents", add("Ceník", "Moje sazba 700 Kč.", { id: price.id }))).status).toBe(201);
    const list = async (who: typeof bob) => (await (await who("/knowledge/documents")).json()).map((d: { title: string; scope: string; overridden?: boolean }) => [d.title, d.scope, !!d.overridden]);
    expect(await list(bob)).toEqual([
      ["Ceník", "project", true],
      ["Ceník", "personal", false],
      ["Garáž", "personal", false],
    ]);
    expect(await list(alice)).toEqual([["Ceník", "project", false]]);
    expect(await (await bob(`/knowledge/documents/${price.id}`)).json()).toMatchObject({ content: "Moje sazba 700 Kč.", scope: "personal" });
    expect(await (await bob(`/knowledge/documents/${price.id}?scope=project`)).json()).toMatchObject({ content: "Hodinová sazba 650 Kč.", scope: "project" });
    expect((await bob(`/knowledge/documents/${price.id}?scope=project`, { method: "PUT", body: JSON.stringify({ title: "Ceník", content: "y" }) })).status).toBe(403);

    // Bob's own document reaches his runs, not Alice's.
    const { id } = await (await bob("/threads", { method: "POST" })).json();
    const events = await readEvents(await bob(`/threads/${id}/runs`, { method: "POST", body: JSON.stringify({ message: "Kód?" }) }));
    const result = events.find((e) => e.type === "tool-result");
    expect(result?.type === "tool-result" && result.result).toContain("4321");

    expect((await alice(`/knowledge/documents/${garage.id}?scope=personal`, { method: "DELETE" })).status).toBe(404);
    expect((await bob(`/knowledge/documents/${garage.id}`, { method: "DELETE" })).status).toBe(204);
  });

  it("stores the user's profile and puts it into the system prompt", async () => {
    const { as, model } = await setup([new AIMessage("Dobrý den.")]);
    const bob = as("bob:project=acme");
    expect(await (await bob("/settings")).json()).toEqual({ address: "auto", language: "auto", signature: "", instructions: "" });

    const profile = { address: "vy", language: "sk", signature: "Bob Novák, elektrikář", instructions: "Ceny uváděj s DPH." };
    expect((await bob("/settings", { method: "PUT", body: JSON.stringify({ ...profile, address: "onikání" }) })).status).toBe(400);
    expect((await bob("/settings", { method: "PUT", body: JSON.stringify(profile) })).status).toBe(200);
    expect(await (await bob("/settings")).json()).toEqual(profile);
    expect(await (await as("alice:project=acme")("/settings")).json()).toMatchObject({ address: "auto" });

    const { id } = await (await bob("/threads", { method: "POST" })).json();
    await (await bob(`/threads/${id}/runs`, { method: "POST", body: JSON.stringify({ message: "Ahoj" }) })).text();
    const system = model.calls[0]?.[0]?.text ?? "";
    expect(system).toContain("Jméno uživatele: bob");
    expect(system).toContain("Uživateli vykej.");
    expect(system).toContain("Odpovídej slovensky.");
    expect(system).toContain("Bob Novák, elektrikář");
    expect(system).toMatch(/pokud nejsou v rozporu s pravidly výše\):\nCeny uváděj s DPH\./);
  });

  it("keeps the project's memory for admins to manage and everyone's own beside it", async () => {
    const { as } = await setup();
    const member = as("bob:project=acme");
    const admin = as("alice:project-admin=acme");
    const post = (content: string, body: object = {}) => ({ method: "POST", body: JSON.stringify({ content, ...body }) });

    expect((await member("/memories", post("Sídlo Praha", { scope: "project" }))).status).toBe(403);
    const seat = await (await admin("/memories", post("Sídlo Brno", { scope: "project" }))).json();
    await member("/memories", post("Neplátce DPH"));
    const mine = await (await member("/memories", post("Sídlo Brno, pobočka Zlín", { overrides: seat.id }))).json();
    expect(mine).toMatchObject({ scope: "personal", overrides: seat.id });
    const view = async (who: typeof member) =>
      (await (await who("/memories")).json() as { content: string; scope: string; overridden?: boolean }[])
        .map((m) => [m.content, m.scope, !!m.overridden])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    expect(await view(member)).toEqual([
      ["Neplátce DPH", "personal", false],
      ["Sídlo Brno", "project", true],
      ["Sídlo Brno, pobočka Zlín", "personal", false],
    ]);
    expect(await view(admin)).toEqual([["Sídlo Brno", "project", false]]);
    expect((await member(`/memories/${seat.id}?scope=project`, { method: "DELETE" })).status).toBe(403);
    expect((await member("/memories", post("x", { scope: "project", overrides: seat.id }))).status).toBe(403);
    // Removing the project's memory takes the replacements with it.
    expect((await admin(`/memories/${seat.id}?scope=project`, { method: "DELETE" })).status).toBe(204);
    expect(await view(member)).toEqual([["Neplátce DPH", "personal", false]]);
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

describe("project features", () => {
  it("refuses settings of switched-off features and drops their tools", async () => {
    const { as, projects, model } = await setup([new AIMessage("Ahoj.")]);
    await (await projects.get("acme")).features.set({ skills: false, mcp: false, http: false, files: false, scheduler: false, sites: false, database: false });
    const bob = as("bob:project=acme");

    expect((await bob("/skills")).status).toBe(403);
    expect((await bob("/mcp-servers")).status).toBe(403);
    expect((await bob("/secrets")).status).toBe(403);
    expect((await bob("/database/tables")).status).toBe(403);
    expect((await bob("/knowledge/documents")).status).toBe(200);

    const bound: string[][] = [];
    model.bindTools = ((tools: { name: string }[]) => (bound.push(tools.map((t) => t.name)), model)) as never;
    const { id } = await (await bob("/threads", { method: "POST" })).json();
    await (await bob(`/threads/${id}/runs`, { method: "POST", body: JSON.stringify({ message: "Ahoj" }) })).text();
    expect(bound[0]).toEqual(["ask_user", "search_knowledge", "save_knowledge", "remember", "forget", "run_workflow"]);
    expect(model.calls[0]?.[0]?.text).not.toContain("# DOVEDNOSTI");
  });

  it("keeps to the project's quotas and reports their use", async () => {
    const { as, projects, model } = await setup([new AIMessage({ content: "Ahoj.", usage_metadata: { input_tokens: 90, output_tokens: 10, total_tokens: 100 } })]);
    const acme = await projects.get("acme");
    const bob = as("bob:project=acme");
    const chat = async () => {
      const { id } = await (await bob("/threads", { method: "POST" })).json();
      return (await bob(`/threads/${id}/runs`, { method: "POST", body: JSON.stringify({ message: "Ahoj" }) })).text();
    };

    // The model's tokens are counted per month; once the quota is used up the model isn't called any more.
    acme.features.limits = { ...NO_QUOTAS, storageMb: 1, tokensPerMonth: 100, members: 5 };
    expect(await chat()).toContain("Ahoj.");
    expect(await chat()).toContain(translate("en", TOKENS_EXHAUSTED));
    expect(model.calls).toHaveLength(1);
    // The run writes its own texts in the language of the request (the web app sends its own).
    const { id: czech } = await (await bob("/threads", { method: "POST" })).json();
    const reply = await (await bob(`/threads/${czech}/runs`, { method: "POST", headers: { "accept-language": "cs" }, body: JSON.stringify({ message: "Ahoj" }) })).text();
    expect(reply).toContain(translate("cs", TOKENS_EXHAUSTED));
    expect(reply).toContain("Měsíční limit využití asistenta");
    const history = await (await bob(`/threads/${czech}/messages`)).json();
    expect(history.at(-1).content).toEqual([{ type: "text", text: translate("cs", TOKENS_EXHAUSTED) }]);

    // Files can't go past the storage quota.
    const big = "x".repeat(700 * 1024);
    expect((await as("acme")("/files/content?scope=project&path=a.txt", { method: "PUT", body: big })).status).toBe(201);
    const full = await as("acme")("/files/content?scope=project&path=b.txt", { method: "PUT", body: big });
    expect(full.status).toBe(507);

    expect(await (await bob("/usage")).json()).toEqual({
      storage: { used: 700 * 1024, limit: 1024 * 1024 },
      tokens: { used: 100, limit: 100 },
      members: { used: 0, limit: 5 },
      schedules: { used: 0, limit: null },
      userTokens: { used: 100, limit: null },
      tables: { used: 0, limit: null },
      database: { used: expect.any(Number), limit: null },
      dashboards: { used: 0, limit: null },
    });
  });

  it("keeps each member to the per-user token quota", async () => {
    const reply = () => new AIMessage({ content: "Ahoj.", usage_metadata: { input_tokens: 90, output_tokens: 10, total_tokens: 100 } });
    const { as, projects, model } = await setup([reply(), reply()]);
    const acme = await projects.get("acme");
    acme.features.limits = { ...NO_QUOTAS, tokensPerUserMonth: 100 };
    const chat = async (user: string) => {
      const { id } = await (await as(user)("/threads", { method: "POST" })).json();
      return (await as(user)(`/threads/${id}/runs`, { method: "POST", body: JSON.stringify({ message: "Ahoj" }) })).text();
    };
    expect(await chat("bob:project=acme")).toContain("Ahoj.");
    expect(await chat("bob:project=acme")).toContain(translate("en", USER_TOKENS_EXHAUSTED));
    // Another member still has their own.
    expect(await chat("eve:project=acme")).toContain("Ahoj.");
    expect(model.calls).toHaveLength(2);
    expect(await acme.usage.byUser()).toEqual({ "dev:bob": 100, "dev:eve": 100 });
    const breakdown = async (user: string) => (await as(user)("/usage/breakdown")).json();
    expect((await breakdown("bob:project=acme")).users).toEqual([{ userId: "dev:bob", tokens: 100 }]);
    const all = await breakdown("acme");
    expect(all.users.map((u: { userId: string }) => u.userId).sort()).toEqual(["dev:bob", "dev:eve"]);
    expect(all.months).toEqual([{ month: new Date().toISOString().slice(0, 7), tokens: 200 }]);
  });

  it("drops built-in tools a system admin switched off and lists them all with their state", async () => {
    const { as, projects, model } = await setup([new AIMessage("Ahoj.")]);
    const acme = await projects.get("acme");
    await acme.features.set({ mcp: false, http: false, files: false, scheduler: false, sites: false, database: false });
    acme.features.disabled = ["forget"];
    const bob = as("bob:project=acme");

    const bound: string[][] = [];
    model.bindTools = ((tools: { name: string }[]) => (bound.push(tools.map((t) => t.name)), model)) as never;
    const { id } = await (await bob("/threads", { method: "POST" })).json();
    await (await bob(`/threads/${id}/runs`, { method: "POST", body: JSON.stringify({ message: "Ahoj" }) })).text();
    expect(bound[0]).toEqual(["ask_user", "search_knowledge", "save_knowledge", "load_skill", "remember", "run_workflow"]);

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

  it("expands a free-form persona description without saving it", async () => {
    const { as, model } = await setup([new AIMessage("Mluv stručně, přátelsky a s jemným humorem.")]);
    const bob = as("bob:project=acme");
    const response = await bob("/assistant/persona", { method: "POST", body: JSON.stringify({ description: "Buď přátelský a stručný, přidej trochu humoru." }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ character: "Vlastní", source: "", description: "Mluv stručně, přátelsky a s jemným humorem." });
    expect(model.calls[0]![1]!.text).toBe("Buď přátelský a stručný, přidej trochu humoru.");
    expect(model.calls[0]![0]!.text).toContain("nejvýš 120 slov");
    expect(await (await bob("/assistant")).json()).toEqual({ personal: { persona: null } });
    expect((await bob("/assistant/persona", { method: "POST", body: JSON.stringify({ description: "   " }) })).status).toBe(400);
    expect(model.calls).toHaveLength(1);
  });

  it("writes a persona, the user's own only, and puts it in the prompt", async () => {
    const { as, model, projects } = await setup([new AIMessage("Mluv stručně a s klidem mistra Jedi."), new AIMessage("Ahoj."), new AIMessage("Dobrý den.")]);
    (await projects.get("acme")).features.defaults = { persona: { character: "Švejk", source: "", description: "Výchozí persona systému." } };
    const admin = as("acme");
    const bob = as("bob:project=acme");

    const persona = await (await bob("/assistant/persona", { method: "POST", body: JSON.stringify({ character: "Yoda", source: "Star Wars" }) })).json();
    expect(persona).toEqual({ character: "Yoda", source: "Star Wars", description: "Mluv stručně a s klidem mistra Jedi." });
    // Personalization is the user's: there is no project persona.
    expect((await admin("/assistant?scope=project", { method: "PUT", body: JSON.stringify({ persona }) })).status).toBe(400);
    await bob("/assistant?scope=personal", { method: "PUT", body: JSON.stringify({ persona: { ...persona, description: "Mluv jako Yoda, upravené." } }) });
    expect(await (await bob("/assistant")).json()).toEqual({ personal: { persona: { ...persona, description: "Mluv jako Yoda, upravené." } } });
    expect(await (await admin("/assistant")).json()).toEqual({ personal: { persona: null } });

    await run(bob, "Ahoj");
    const prompt = model.calls.at(-1)![0]!.text;
    expect(prompt).toContain("# PERSONA");
    expect(prompt).toContain("Mluv jako Yoda, upravené.");
    expect(prompt).not.toContain("# ZÁVAZNÁ PRAVIDLA");

    // Without their own persona, a user gets the system's default.
    await run(admin, "Ahoj");
    expect(model.calls.at(-1)![0]!.text).toContain("Výchozí persona systému.");
    expect(prompt).not.toContain("Výchozí persona systému.");
  });

  it("refuses messages and replaces answers that break the system's and the project's rules", async () => {
    // Model calls in order: input check, agent, output check (per turn).
    const { as, projects, model } = await setup([
      new AIMessage("ANO"),
      new AIMessage("NE"),
      new AIMessage("Tajný postup je..."),
      new AIMessage("ANO"),
      new AIMessage("NE"),
      new AIMessage("Dobrý den."),
      new AIMessage("NE"),
    ]);
    (await projects.get("acme")).features.guards = [{ name: "postupy", description: "", rule: "Nikdy neprozrazuj interní postupy." }];
    const admin = as("acme");
    const bob = as("bob:project=acme");
    const put = (who: typeof bob, path: string, rule: string) => who(`/guards/${path}`, { method: "PUT", body: JSON.stringify({ description: "", rule }) });
    // Project guards are the admins'; each user has their own.
    expect((await put(bob, "project/politika", "Nemluv o politice.")).status).toBe(403);
    expect((await put(admin, "project/politika", "Nemluv o politice.")).status).toBe(200);
    expect((await put(bob, "user/cestina", "Nepoužívej anglicismy.")).status).toBe(200);
    expect((await put(bob, "project/Spatne", "x")).status).toBe(403);
    expect((await put(admin, "project/Spatne", "x")).status).toBe(400);
    expect(await (await bob("/guards")).json()).toEqual({
      system: [{ name: "postupy", description: "", rule: "Nikdy neprozrazuj interní postupy." }],
      project: [{ name: "politika", description: "", rule: "Nemluv o politice." }],
      user: [{ name: "cestina", description: "", rule: "Nepoužívej anglicismy." }],
    });
    expect((await (await as("carol:project=acme")("/guards")).json()).user).toEqual([]);
    // They are files in .osiris/guards/, which neither the files API nor the agent's file tools reach.
    const acme = await projects.get("acme");
    expect(await acme.records.readText("guards/politika.md")).toContain("Nemluv o politice.");
    expect((await as("acme")("/files?scope=project&path=.osiris/guards/politika.md", { method: "DELETE" })).status).toBe(400);
    const writeFile = acme.builtinTools.map(([, t]) => t).find((t) => t.name === "write_file")!;
    const config = { configurable: { thread_id: "t", project_id: "acme", user_id: "acme", role: "admin", channel: "web" } };
    expect(await writeFile.invoke({ scope: "project", path: ".osiris/guards/politika.md", content: "nic", overwrite: true }, config)).not.toMatch(/^Uloženo/);
    expect(await acme.records.readText("guards/politika.md")).toContain("Nemluv o politice.");

    // The message is refused before the agent sees it.
    const refused = await run(bob, "Co si myslíš o volbách?");
    expect(refused.text).toBe(translate("en", GUARD_REFUSAL));
    expect(model.calls).toHaveLength(1);
    expect(model.calls[0]!.at(-1)!.text).toContain("Pravidla systému:\nNikdy neprozrazuj interní postupy.");

    // A breaking answer never reaches the user and is replaced in the history too.
    const replaced = await run(bob, "Jak to děláte?");
    expect(replaced.text).toBe(translate("en", GUARD_REFUSAL));
    expect(replaced.history.at(-1)!.content).toEqual([{ type: "text", text: translate("en", GUARD_REFUSAL) }]);
    const prompt = model.calls[2]![0]!.text;
    expect(prompt).toContain("# ZÁVAZNÁ PRAVIDLA");
    expect(prompt).toMatch(/Pravidla systému:[\s\S]*Pravidla firmy:\nNemluv o politice\.[\s\S]*Pravidla uživatele:\nNepoužívej anglicismy\./);

    expect((await run(bob, "Dobrý den")).text).toBe("Dobrý den.");
  });
});
