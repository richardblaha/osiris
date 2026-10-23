import { AIMessage } from "@langchain/core/messages";
import { describe, expect, it, vi } from "vitest";
import { davFetch } from "@osiris/core/integrations/dav.ts";
import { createAgentModels } from "@osiris/core/agent/model.ts";
import { createTestApp, createTestProjects, ScriptedChatModel } from "./helpers.ts";

const mail = { kind: "mail", from: "bob@example.cz", incoming: { protocol: "imap", host: "mail.example.cz", port: 993, username: "bob", password: "secret-password" } };

async function setup() {
  const { projects, model } = createTestProjects([new AIMessage("OK"), new AIMessage("OK")]);
  const app = await createTestApp(projects);
  const as = (user: string) => (path: string, init: RequestInit = {}) => app.request(`/api${path}`, { ...init, headers: { authorization: `Bearer ${user}:project=acme`, "x-project-id": "acme", "content-type": "application/json" } });
  return { projects, model, bob: as("bob"), eva: as("eva") };
}

describe("standard integrations", () => {
  it("seals credentials, isolates account owners and exposes only connected tools", async () => {
    const { projects, model, bob, eva } = await setup();
    expect((await bob("/integrations/standard/work", { method: "PUT", body: JSON.stringify(mail) })).status).toBe(200);
    expect(await (await bob("/integrations/standard")).json()).toEqual([{ name: "work", kind: "mail" }]);
    expect(await (await eva("/integrations/standard")).json()).toEqual([]);
    const project = await projects.get("acme");
    const rows = await project.db.execute("SELECT data_enc FROM standard_accounts");
    expect(String(rows.rows[0]!.data_enc)).not.toContain("secret-password");
    await expect(project.standardAccounts.get("dev:eva", "work")).rejects.toThrow("isn't connected");
    const bound: string[][] = [];
    model.bindTools = ((tools: { name: string }[]) => { bound.push(tools.map(t => t.name)); return model; }) as never;
    for (const who of [bob, eva]) {
      const { id } = await (await who("/threads", { method: "POST" })).json();
      await (await who(`/threads/${id}/runs`, { method: "POST", body: JSON.stringify({ message: "Ahoj" }) })).text();
    }
    expect(bound[0]).toContain("mail_read");
    expect(bound[0]).toContain("standard_accounts");
    expect(bound[0]).not.toContain("caldav_read");
    expect(bound[1]).not.toContain("mail_read");
    await eva("/integrations/standard/work", { method: "DELETE" });
    expect((await project.standardAccounts.list("dev:bob"))).toHaveLength(1);
    await bob("/integrations/standard/work", { method: "DELETE" });
    expect(await project.standardAccounts.list("dev:bob")).toEqual([]);
  });

  it("rejects malformed accounts and requires the integrations feature", async () => {
    const { bob, projects } = await setup();
    expect((await bob("/integrations/standard/work", { method: "PUT", body: JSON.stringify({ ...mail, incoming: undefined }) })).status).toBe(400);
    expect((await bob("/integrations/standard/work", { method: "PUT", body: JSON.stringify({ kind: "caldav", url: "http://example.cz", username: "bob", password: "pass" }) })).status).toBe(400);
    const t = await projects.get("acme");
    const features = t.features as unknown as { features: { integrations: boolean } };
    features.features.integrations = false;
    expect((await bob("/integrations/standard")).status).toBe(403);
  });

  it("refuses cross-origin DAV discovery, private hosts and oversized responses", async () => {
    const fake = vi.fn(async () => new Response("OK")) as unknown as typeof fetch;
    await expect(davFetch("https://example.cz", true, fake)("https://evil.cz/calendar")).rejects.toThrow("origin");
    await expect(davFetch("https://127.0.0.1", false, fake)("https://127.0.0.1/")).rejects.toThrow("private network");
    expect(fake).not.toHaveBeenCalled();
    const big = (async () => new Response("x", { headers: { "content-length": "20000000" } })) as typeof fetch;
    await expect(davFetch("https://example.cz", true, big)("https://example.cz/")).rejects.toThrow("10 MB");
    await davFetch("https://example.cz", true, fake)("https://example.cz/cal");
    expect(fake).toHaveBeenCalledWith("https://example.cz/cal", expect.objectContaining({ redirect: "error" }));
  });
});

describe("system model roles", () => {
  it("routes the first step and tool results to their assigned models", async () => {
    const agent = new ScriptedChatModel([new AIMessage({ content: "", tool_calls: [{ id: "call1", name: "remember", args: { content: "Firma sídlí v Praze" } }] })]);
    const tools = new ScriptedChatModel([new AIMessage("Hotovo")]);
    const guard = new ScriptedChatModel([]);
    const persona = new ScriptedChatModel([]);
    const { projects } = createTestProjects([], [], undefined, { models: { agent, tools, guard, persona } });
    const project = await projects.get("acme");
    await project.graph.invoke({ messages: [{ role: "user", content: "Zapamatuj si sídlo" }] }, { configurable: { project_id: "acme", user_id: "bob", role: "admin", channel: "web", thread_id: "routing" } });
    expect(agent.calls).toHaveLength(1);
    expect(tools.calls).toHaveLength(1);
    expect(guard.calls).toHaveLength(0);
    expect(project.model).toBe(agent);
    expect(project.personaModel).toBe(persona);
  });

  it("uses the guard model for input and output and accounts for its tokens", async () => {
    const agent = new ScriptedChatModel([new AIMessage({ content: "Odpověď", usage_metadata: { input_tokens: 2, output_tokens: 3, total_tokens: 5 } })]);
    const guard = new ScriptedChatModel([new AIMessage({ content: "NE", usage_metadata: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }), new AIMessage({ content: "ANO", usage_metadata: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } })]);
    const { projects } = createTestProjects([], [], undefined, { models: { agent, guard, tools: agent, persona: agent } });
    const project = await projects.get("acme");
    project.features.guards = [{ name: "rule", description: "", rule: "Používej češtinu" }];
    const result = await project.graph.invoke({ messages: [{ role: "user", content: "Ahoj" }] }, { configurable: { project_id: "acme", user_id: "bob", role: "admin", channel: "web", thread_id: "guard-routing" } });
    expect(guard.calls).toHaveLength(2);
    expect(agent.calls).toHaveLength(1);
    expect(result.messages.at(-1)?.text).not.toBe("Odpověď");
    expect(await project.usage.tokens()).toBe(9);
  });

  it("rejects unknown providers before initializing models", async () => {
    await expect(createAgentModels({ agent: "unknown:model", tools: "unknown:model", guard: "unknown:model", persona: "unknown:model" })).rejects.toThrow("Invalid agent model");
  });
});
