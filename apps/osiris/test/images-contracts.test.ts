import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AIMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { ImageService, imageRequest } from "@osiris/tools-images/service.ts";
import { ImageJobStore } from "@osiris/tools-images/store.ts";
import { FileStore } from "@osiris/core/files/store.ts";
import { Records } from "@osiris/core/projects/records.ts";
import { createThread } from "@osiris/core/repo/threads.ts";
import type { McpToolset } from "@osiris/core/mcp/toolset.ts";
import { ScriptedChatModel, allText, createTestProjects } from "./helpers.ts";
import contracts from "./fixtures/comfy-cloud-contracts.json";
const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64");
const ctx = { thread_id: "thread", project_id: "acme", user_id: "alice", role: "member" as const, channel: "web" as const }, config = { configurable: ctx };
const resources: { dir: string; db: Records }[] = [];
afterEach(async () => { for (const { dir } of resources.splice(0)) { await rm(dir, { recursive: true, force: true }); } });
const plan = (name: string, args: Record<string, unknown>) => new AIMessage({ content: "", tool_calls: [{ id: name, name: `comfy-cloud_${name}`, args }] });
async function fixture(batch: boolean, invalid = false) {
  const dir = await mkdtemp(join(tmpdir(), "osiris-image-contract-")), db = new Records(join(dir, ".osiris")); resources.push({ dir, db });
  await createThread(db, "alice", "thread", "web");
  let paid = 0;
  const tools = Object.entries(contracts.tools).map(([name, raw]) => tool(async (args: Record<string, unknown>) => {
    if (name === "search_templates") return JSON.stringify({ data: [{ name: contracts.template.id, tags: ["Text to Image"], models: ["Z-Image-Turbo"] }] });
    if (name === "get_template_schema") return JSON.stringify(contracts.template);
    if (name === "run_template" || name === "submit_batch") {
      paid++; expect(args.confirm).toBe(true);
      return batch ? { batch_id: "batch-1", jobs: [{ prompt_id: "job-a" }, { prompt_id: "job-b" }] } : { prompt_id: "job-a", status: "in_progress" };
    }
    if (name === "get_job_status") return { prompt_id: "job-a", status: "completed" };
    if (name === "get_batch_status") return { batch_id: "batch-1", jobs: [{ id: "job-a", state: "ready" }, { id: "job-b", state: "ready" }], summary: { pending: 0, ready: 2, failed: 0 } };
    if (name === "get_output") return { urls: ["https://93.184.215.14/a.png"] };
    if (name === "get_batch_output") return { batch_id: "batch-1", outputs: [{ url: "https://93.184.215.14/a.png" }, { url: "https://93.184.215.14/b.png" }], pending: [], failed: [] };
    return {};
  }, { name: `comfy-cloud_${name}`, description: name, schema: raw as { type: "object" } }));
  const overrides = invalid ? { "missing.prompt": "cat" } : { "57.text": "cat", "57.width": 256, "57.height": 256, "57.seed": 42 };
  const script = [plan("search_templates", { q: "text to image", media_type: "image" }), plan("get_template_schema", { template_id: contracts.template.id }), batch ? plan("submit_batch", { client_os: "linux", items: [0, 1].map(() => ({ tool: "run_template", name: contracts.template.id, slot_overrides: overrides })) }) : plan("run_template", { name: contracts.template.id, slot_overrides: overrides })];
  // Only expose the selected route's live contracts, avoiding optional model discovery in this fixture.
  const mcp = { tools: async () => tools.filter(t => !["comfy-cloud_partner_generate"].includes(t.name)) } as unknown as McpToolset;
  const service = new ImageService(new ImageJobStore(db), new FileStore(dir), mcp, new ScriptedChatModel(script), { downloadHosts: ["93.184.215.14"], fetch: async () => new Response(new Uint8Array(image), { headers: { "content-type": "image/png" } }) });
  return { service, paid: () => paid };
}
it("executes the real discovered template/slot contract and retrieves the same job", async () => {
  const f = await fixture(false);
  const initial = await f.service.generate(imageRequest.parse({ prompt: "cat" }), config, "live-contract");
  expect(initial).toMatchObject({ status: "running" });
  expect((await f.service.status(initial.id, config)).status).toBe("completed");
  expect(f.paid()).toBe(1);
});
it("rejects a slot not advertised by the real template before any paid call", async () => {
  const f = await fixture(false, true);
  expect(await f.service.generate(imageRequest.parse({ prompt: "cat" }), config, "invalid-slot")).toMatchObject({ status: "failed", error: "UNKNOWN_WORKFLOW_SLOT" });
  expect(f.paid()).toBe(0);
});
it("submits multiple independent images as one real-schema batch and collects all artifacts", async () => {
  const f = await fixture(true);
  const initial = await f.service.generate(imageRequest.parse({ prompt: "two cats", output: { count: 2 } }), config, "batch");
  expect(initial.id).toEqual(expect.any(String));
  const completed = await f.service.status(initial.id, config);
  expect(completed.status).toBe("completed"); expect(completed.artifacts).toHaveLength(2); expect(f.paid()).toBe(1);
});
it("bootstraps a missing MCP connection with a sealed host-scoped key without replacing existing OAuth", async () => {
  const { projects } = createTestProjects([], [], async () => ({ tools: [], close: async () => {} }), { images: {}, comfyApiKey: "test-runtime-key" });
  const project = await projects.get("bootstrap");
  try {
    expect((await project.mcpServers.get("comfy-cloud", ""))?.headers).toEqual({ "X-API-Key": "{{secret:COMFY_API_KEY}}" });
    expect(await allText(project.records)).not.toContain("test-runtime-key");
    expect((await project.secrets.fill({ key: "{{secret:COMFY_API_KEY}}" }, { userId: "", host: "cloud.comfy.org" })).filled.key).toBe("test-runtime-key");
    await project.mcpServers.put("comfy-cloud", "", { url: "https://cloud.comfy.org/mcp", auth: "oauth", enabled: false });
    await project.init();
    expect(await project.mcpServers.get("comfy-cloud", "")).toMatchObject({ auth: "oauth", enabled: false });
  } finally { await project.mcp.close(); }
});
