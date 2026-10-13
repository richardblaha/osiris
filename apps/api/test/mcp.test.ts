import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createApp } from "../src/app.ts";
import { createDevVerifier } from "../src/auth/oidc.ts";
import { McpServerStore } from "../src/mcp/store.ts";
import type { McpConnector } from "../src/mcp/toolset.ts";
import { assertSafeMcpUrl } from "../src/mcp/url.ts";
import { SecretBox } from "../src/secrets.ts";
import { createTestDb, createTestTenants } from "./helpers.ts";

/** Fake MCP servers: `weather` has one tool, `broken` fails to connect. Records the headers it was given. */
function fakeMcp() {
  const seen: Record<string, Record<string, string>> = {};
  const connect: McpConnector = async ({ name, headers }) => {
    seen[name] = headers;
    if (name === "broken") throw new Error("connection refused");
    const forecast = tool(async ({ city }) => `${city}: slunečno, 21 °C`, {
      name: `${name}_forecast`,
      description: "Předpověď počasí",
      schema: z.object({ city: z.string() }),
    });
    return { tools: [forecast], close: async () => {} };
  };
  return { connect, seen };
}

describe("SecretBox", () => {
  it("round-trips and detects tampering", () => {
    const box = SecretBox.insecureDev();
    const sealed = box.seal("Bearer abc");
    expect(sealed).not.toContain("abc");
    expect(box.open(sealed)).toBe("Bearer abc");
    expect(() => box.open(sealed.slice(0, -2) + "xx")).toThrow();
  });
});

describe("MCP URL guard", () => {
  it("requires https and public addresses", async () => {
    await expect(assertSafeMcpUrl("http://93.184.215.14/mcp")).rejects.toThrow(/https/);
    for (const host of ["127.0.0.1", "10.43.0.1", "169.254.169.254", "192.168.1.2", "[::1]", "[fd00::1]", "[::ffff:10.0.0.1]"]) {
      await expect(assertSafeMcpUrl(`https://${host}/mcp`)).rejects.toThrow(/privátní/);
    }
    await expect(assertSafeMcpUrl("https://user:pw@93.184.215.14/mcp")).rejects.toThrow(/hlavičky/);
    await expect(assertSafeMcpUrl("https://93.184.215.14/mcp")).resolves.toBeInstanceOf(URL);
  });

  it("allows localhost over http only in development mode", async () => {
    await expect(assertSafeMcpUrl("http://localhost:8080/mcp", { allowPrivate: true })).resolves.toBeInstanceOf(URL);
  });
});

describe("McpServerStore", () => {
  it("encrypts headers, lists only their names and keeps them when omitted", async () => {
    const db = await createTestDb();
    const store = new McpServerStore(db, SecretBox.insecureDev());
    await store.put("crm", { url: "https://crm.example/mcp", enabled: true, headers: { Authorization: "Bearer s3cret" } });

    const raw = await db.execute("SELECT headers_enc FROM mcp_servers");
    expect(String(raw.rows[0]?.headers_enc)).not.toContain("s3cret");
    expect(await store.list()).toMatchObject([{ name: "crm", headerNames: ["Authorization"], enabled: true }]);

    await store.put("crm", { url: "https://crm.example/v2", enabled: false });
    expect((await store.get("crm"))?.headers).toEqual({ Authorization: "Bearer s3cret" });
    expect(await store.enabled()).toEqual([]);
  });
});

describe("MCP tools in the agent", () => {
  it("offers the tenant's MCP tools to the model and runs them, skipping a broken server", async () => {
    const mcp = fakeMcp();
    const { tenants, model } = createTestTenants(
      [
        new AIMessage({ content: "", tool_calls: [{ id: "w1", name: "weather_forecast", args: { city: "Brno" } }] }),
        new AIMessage("V Brně je slunečno."),
      ],
      [],
      mcp.connect,
    );
    const tenant = await tenants.get("acme");
    await tenant.mcpServers.put("weather", { url: "https://w.example/mcp", enabled: true, headers: { "X-Key": "k" } });
    await tenant.mcpServers.put("broken", { url: "https://b.example/mcp", enabled: true });

    const ctx = { thread_id: "t", tenant_id: "acme", user_id: "u", role: "member" as const, channel: "web" as const };
    const state = await tenant.graph.invoke({ messages: [new HumanMessage("Jaké je počasí v Brně?")] }, { configurable: ctx });

    expect(state.messages.find((m) => ToolMessage.isInstance(m))?.text).toBe("Brno: slunečno, 21 °C");
    expect(mcp.seen.weather).toEqual({ "X-Key": "k" });
    expect(tenant.mcp.status().get("broken")).toEqual({ ok: false, error: "connection refused" });
    expect(model.calls).toHaveLength(2);
  });

  it("keeps MCP servers per tenant", async () => {
    const mcp = fakeMcp();
    const { tenants } = createTestTenants([], [], mcp.connect);
    await (await tenants.get("acme")).mcpServers.put("weather", { url: "https://w.example/mcp", enabled: true });
    expect(await (await tenants.get("beta")).mcp.tools()).toEqual([]);
    expect((await (await tenants.get("acme")).mcp.tools()).map((t) => t.name)).toEqual(["weather_forecast"]);
  });
});

describe("MCP API", () => {
  async function setup() {
    const mcp = fakeMcp();
    const { tenants } = createTestTenants([], [], mcp.connect);
    const app = createApp({ verifier: createDevVerifier(), tenants, corsOrigin: "*" });
    const as = (user: string) => (path: string, init: RequestInit = {}) =>
      app.request(`/api${path}`, { ...init, headers: { authorization: `Bearer ${user}`, "content-type": "application/json" } });
    return { as, tenants };
  }
  const put = (body: unknown) => ({ method: "PUT", body: JSON.stringify(body) });

  it("is admin-only, validates input and never returns header values", async () => {
    const { as } = await setup();
    const admin = as("alice:tenant-acme-admin");
    const member = as("bob:tenant-acme");

    expect((await member("/mcp-servers")).status).toBe(403);
    expect((await admin("/mcp-servers/Bad_Name", put({ url: "https://93.184.215.14/mcp" }))).status).toBe(400);
    expect((await admin("/mcp-servers/x", put({ url: "https://169.254.169.254/latest" }))).status).toBe(400);
    expect((await admin("/mcp-servers/x", put({ url: "https://93.184.215.14/mcp", headers: { "Bad Header": "v" } }))).status).toBe(400);
    expect((await admin("/mcp-servers/x", put({ url: "https://93.184.215.14/mcp", headers: { A: "v\r\nInjected: 1" } }))).status).toBe(400);

    const ok = await admin("/mcp-servers/weather", put({ url: "https://93.184.215.14/mcp", headers: { Authorization: "Bearer s3cret" } }));
    expect(ok.status).toBe(204);
    const listed = await (await admin("/mcp-servers")).text();
    expect(listed).toContain('"headerNames":["Authorization"]');
    expect(listed).not.toContain("s3cret");

    expect(await (await admin("/mcp-servers/weather/test", { method: "POST" })).json()).toEqual({ ok: true, tools: ["weather_forecast"] });
    expect(await (await admin("/mcp-servers")).json()).toMatchObject([{ status: { ok: true, tools: ["weather_forecast"] } }]);
    expect((await admin("/mcp-servers/weather", { method: "DELETE" })).status).toBe(204);
    expect(await (await admin("/mcp-servers")).json()).toEqual([]);
  });

  it("applies config changes to the agent without a restart", async () => {
    const { as, tenants } = await setup();
    const admin = as("alice:tenant-acme-admin");
    const tenant = await tenants.get("acme");
    expect(await tenant.mcp.tools()).toEqual([]);

    await admin("/mcp-servers/weather", put({ url: "https://93.184.215.14/mcp" }));
    expect((await tenant.mcp.tools()).map((t) => t.name)).toEqual(["weather_forecast"]);

    await admin("/mcp-servers/weather", put({ url: "https://93.184.215.14/mcp", enabled: false }));
    expect(await tenant.mcp.tools()).toEqual([]);
  });
});
