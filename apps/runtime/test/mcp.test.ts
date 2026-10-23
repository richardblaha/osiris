import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { McpServerStore } from "@osiris/core/mcp/store.ts";
import type { McpConnector } from "@osiris/core/mcp/toolset.ts";
import { assertSafePublicUrl } from "@osiris/core/mcp/url.ts";
import { SecretBox } from "@osiris/core/secrets.ts";
import { createTestDb, createTestProjects, createTestApp } from "./helpers.ts";

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
    expect(sealed).not.toContain("Bearer");
    expect(box.open(sealed)).toBe("Bearer abc");
    // Change one character of the sealed text (to one it surely isn't): the tag no longer matches.
    const last = sealed.at(-2)!;
    expect(() => box.open(`${sealed.slice(0, -2)}${last === "A" ? "B" : "A"}${sealed.at(-1)}`)).toThrow();
  });
});

describe("MCP URL guard", () => {
  it("requires https and public addresses", async () => {
    await expect(assertSafePublicUrl("http://93.184.215.14/mcp")).rejects.toThrow(/https/);
    for (const host of ["127.0.0.1", "10.43.0.1", "169.254.169.254", "192.168.1.2", "[::1]", "[fd00::1]", "[::ffff:10.0.0.1]"]) {
      await expect(assertSafePublicUrl(`https://${host}/mcp`)).rejects.toThrow(/private network/);
    }
    await expect(assertSafePublicUrl("https://user:pw@93.184.215.14/mcp")).rejects.toThrow(/use headers/);
    await expect(assertSafePublicUrl("https://93.184.215.14/mcp")).resolves.toBeInstanceOf(URL);
  });

  it("allows localhost over http only in development mode", async () => {
    await expect(assertSafePublicUrl("http://localhost:8080/mcp", { allowPrivate: true })).resolves.toBeInstanceOf(URL);
  });
});

describe("McpServerStore", () => {
  it("encrypts headers, lists only their names and keeps them when omitted", async () => {
    const db = await createTestDb();
    const store = new McpServerStore(db, SecretBox.insecureDev());
    await store.put("crm", "", { url: "https://crm.example/mcp", enabled: true, headers: { Authorization: "Bearer s3cret" } });

    const raw = await db.execute("SELECT headers_enc FROM mcp_servers");
    expect(String(raw.rows[0]?.headers_enc)).not.toContain("s3cret");
    expect(await store.list("u", { showProjectUrls: true })).toMatchObject([
      { name: "crm", scope: "project", url: "https://crm.example/mcp", headerNames: ["Authorization"], enabled: true },
    ]);
    expect((await store.list("u", { showProjectUrls: false }))[0]?.url).toBe("");

    await store.put("crm", "", { url: "https://crm.example/v2", enabled: false });
    expect((await store.get("crm", ""))?.headers).toEqual({ Authorization: "Bearer s3cret" });
    expect(await store.enabled("")).toEqual([]);
  });

  it("keeps personal servers private, each replacing the project's of its name for its owner", async () => {
    const store = new McpServerStore(await createTestDb(), SecretBox.insecureDev());
    await store.put("kalendar", "alice", { url: "https://cal.example/mcp", enabled: true });

    expect(await store.list("bob", { showProjectUrls: true })).toEqual([]);
    expect(await store.list("alice", { showProjectUrls: false })).toMatchObject([{ name: "kalendar", scope: "personal", url: "https://cal.example/mcp" }]);
    await store.put("kalendar", "bob", { url: "https://x.example/mcp", enabled: true });
    await store.put("kalendar", "", { url: "https://firm.example/mcp", enabled: true });
    expect(await store.list("alice", { showProjectUrls: true })).toMatchObject([
      { name: "kalendar", scope: "project", overridden: true },
      { name: "kalendar", scope: "personal", url: "https://cal.example/mcp" },
    ]);
    expect(await store.list("carol", { showProjectUrls: true })).toEqual([expect.not.objectContaining({ overridden: true })]);
  });
});

const run = (user: string, role: "admin" | "member" = "member") => ({
  configurable: { thread_id: `t-${user}`, project_id: "acme", user_id: user, role, channel: "web" as const },
});

describe("MCP tools in the agent", () => {
  it("offers the project's MCP tools to the model and runs them, skipping a broken server", async () => {
    const mcp = fakeMcp();
    const { projects, model } = createTestProjects(
      [
        new AIMessage({ content: "", tool_calls: [{ id: "w1", name: "weather_forecast", args: { city: "Brno" } }] }),
        new AIMessage("V Brně je slunečno."),
      ],
      [],
      mcp.connect,
    );
    const project = await projects.get("acme");
    await project.mcpServers.put("weather", "", { url: "https://w.example/mcp", enabled: true, headers: { "X-Key": "k" } });
    await project.mcpServers.put("broken", "", { url: "https://b.example/mcp", enabled: true });

    const state = await project.graph.invoke({ messages: [new HumanMessage("Jaké je počasí v Brně?")] }, run("u"));

    expect(state.messages.find((m) => ToolMessage.isInstance(m))?.text).toBe("Brno: slunečno, 21 °C");
    expect(mcp.seen.weather).toEqual({ "X-Key": "k" });
    expect(project.mcp.status("").get("broken")).toEqual({ ok: false, error: "connection refused" });
    expect(model.calls).toHaveLength(2);
  });

  it("gives the project's MCP tools to everyone in it and keeps servers per project", async () => {
    const mcp = fakeMcp();
    const { projects } = createTestProjects([], [], mcp.connect);
    const acme = await projects.get("acme");
    await acme.mcpServers.put("weather", "", { url: "https://w.example/mcp", enabled: true });

    expect((await acme.mcp.tools("alice")).map((t) => t.name)).toEqual(["weather_forecast"]);
    expect((await acme.mcp.tools("bob")).map((t) => t.name)).toEqual(["weather_forecast"]);
    expect(await (await projects.get("beta")).mcp.tools("alice")).toEqual([]);
  });
});

describe("MCP API", () => {
  async function setup() {
    const mcp = fakeMcp();
    const { projects } = createTestProjects([], [], mcp.connect);
    const app = await createTestApp(projects);
    const as = (user: string) => (path: string, init: RequestInit = {}) =>
      app.request(`/api${path}`, { ...init, headers: { authorization: `Bearer ${user}`, "content-type": "application/json" } });
    return { as, projects };
  }
  const put = (body: object) => ({ method: "PUT", body: JSON.stringify({ scope: "project", ...body }) });
  const url = "https://93.184.215.14/mcp";

  it("validates input and never returns header values", async () => {
    const { as } = await setup();
    const admin = as("alice:project-admin=acme");

    expect((await admin("/mcp-servers/Bad_Name", put({ url }))).status).toBe(400);
    expect((await admin("/mcp-servers/x", put({ url: "https://169.254.169.254/latest" }))).status).toBe(400);
    expect((await admin("/mcp-servers/x", put({ url, headers: { "Bad Header": "v" } }))).status).toBe(400);
    expect((await admin("/mcp-servers/x", put({ url, headers: { A: "v\r\nInjected: 1" } }))).status).toBe(400);

    const ok = await admin("/mcp-servers/weather", put({ url, scope: "project", headers: { Authorization: "Bearer s3cret" } }));
    expect(ok.status).toBe(204);
    const listed = await (await admin("/mcp-servers")).text();
    expect(listed).toContain('"headerNames":["Authorization"]');
    expect(listed).not.toContain("s3cret");

    const test = await admin("/mcp-servers/weather/test?scope=project", { method: "POST" });
    expect(await test.json()).toEqual({ ok: true, tools: ["weather_forecast"] });
    expect(await (await admin("/mcp-servers")).json()).toMatchObject([{ status: { ok: true, tools: ["weather_forecast"] } }]);
    expect((await admin("/mcp-servers/weather?scope=project", { method: "DELETE" })).status).toBe(204);
    expect(await (await admin("/mcp-servers")).json()).toEqual([]);
  });

  it("lets admins manage the project's servers and hides their addresses from members", async () => {
    const { as } = await setup();
    const admin = as("alice:project-admin=acme");
    const member = as("bob:project=acme");
    expect((await admin("/mcp-servers/weather", put({ url }))).status).toBe(204);

    expect((await member("/mcp-servers/crm", put({ url }))).status).toBe(403);
    expect((await member("/mcp-servers/weather?scope=project", { method: "DELETE" })).status).toBe(403);
    expect(await (await member("/mcp-servers")).json()).toMatchObject([{ name: "weather", scope: "project", url: "" }]);
    expect(await (await admin("/mcp-servers")).json()).toMatchObject([{ name: "weather", scope: "project", url }]);
    expect((await admin("/mcp-servers/weather/test?scope=project", { method: "POST" })).status).toBe(200);
    // A member's own server of the same name replaces the project's for them, and its address is theirs to see.
    expect((await member("/mcp-servers/weather", put({ url, scope: "personal" }))).status).toBe(204);
    expect(await (await member("/mcp-servers")).json()).toMatchObject([
      { name: "weather", scope: "project", url: "", overridden: true },
      { name: "weather", scope: "personal", url },
    ]);
    expect((await member("/mcp-servers/weather?scope=personal", { method: "DELETE" })).status).toBe(204);
    expect((await admin("/mcp-servers/weather?scope=project", { method: "DELETE" })).status).toBe(204);
  });

  it("applies config changes to the agent without a restart", async () => {
    const { as, projects } = await setup();
    const admin = as("alice:project-admin=acme");
    const project = await projects.get("acme");
    expect(await project.mcp.tools("dev:alice")).toEqual([]);

    await admin("/mcp-servers/weather", put({ url }));
    await admin("/mcp-servers/crm", put({ url }));
    expect((await project.mcp.tools("dev:alice")).map((t) => t.name)).toEqual(["crm_forecast", "weather_forecast"]);

    // Bob's own (disabled) weather server hides the project's from his runs only.
    await as("bob:project=acme")("/mcp-servers/weather", put({ url, scope: "personal", enabled: false }));
    expect((await project.mcp.tools("dev:bob")).map((t) => t.name)).toEqual(["crm_forecast"]);

    await admin("/mcp-servers/weather", put({ url, enabled: false }));
    await admin("/mcp-servers/crm?scope=project", { method: "DELETE" });
    expect(await project.mcp.tools("dev:alice")).toEqual([]);
  });
});
