import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AIMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { ImageService, imageRequest, type ImageOptions } from "@osiris/tools-images/service.ts";
import { ImageJobStore } from "@osiris/tools-images/store.ts";
import { FileStore } from "@osiris/core/files/store.ts";
import { ComfyUploadApi } from "@osiris/tools-images/http.ts";
import { SecretVault } from "@osiris/core/vault/vault.ts";
import { SecretBox } from "@osiris/core/secrets.ts";
import { Records } from "@osiris/core/projects/records.ts";
import { createThread } from "@osiris/core/repo/threads.ts";
import type { McpToolset } from "@osiris/core/mcp/toolset.ts";
import { createAgentGraph } from "@osiris/core/agent/graph.ts";
import { FileSaver } from "@osiris/core/checkpointer/file-saver.ts";
import { streamRun } from "@osiris/core/agent/run.ts";
import { imageTools } from "@osiris/tools-images/tools.ts";
import { ScriptedChatModel } from "./helpers.ts";
const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64");
const ctx = { thread_id: "thread", project_id: "acme", user_id: "alice", role: "member" as const, channel: "web" as const };
const config = { configurable: ctx };
const resources: { dir: string; db: Records }[] = [];
afterEach(async () => { for (const { dir } of resources.splice(0)) { await rm(dir, { recursive: true, force: true }); } });
const plan = (name: string, args: Record<string, unknown>) => new AIMessage({ content: "", tool_calls: [{ id: name, name, args }] });
const run = () => plan("comfy-cloud_run_template", { template_name: "image", overrides: { prompt: "cat" } });
const preparation = () => [plan("comfy-cloud_search_templates", { query: "cat" }), plan("comfy-cloud_get_template_schema", { template_name: "image" }), run()];
async function fixture(options: ImageOptions = {}, estimatedCost: number | null = 1, outputCount = 1) {
  const dir = await mkdtemp(join(tmpdir(), "osiris-image-execution-")), db = new Records(join(dir, ".osiris")); resources.push({ dir, db });
  await createThread(db, ctx.user_id, ctx.thread_id, ctx.channel);
  const files = new FileStore(dir), jobs = new ImageJobStore(db), calls: string[] = [];
  let paid = 0, transientStatusErrors = 0;
  const tools = [
    tool(async () => { calls.push("search"); return { templates: [{ id: "image", name: "image", estimated_cost: estimatedCost ?? undefined, capabilities: { generate: true, edit: true, transparency: true } }] }; }, { name: "comfy-cloud_search_templates", description: "Search", schema: z.object({ query: z.string() }) }),
    tool(async () => ({ type: "object", properties: { prompt: { type: "string" }, image: { type: "string" }, mask: { type: "string" } }, required: ["prompt"], additionalProperties: false }), { name: "comfy-cloud_get_template_schema", description: "Schema", schema: z.object({ template_name: z.string() }) }),
    tool(async () => { paid++; return { prompt_id: `job-${paid}`, status: "queued" }; }, { name: "comfy-cloud_run_template", description: "Run", schema: z.object({ template_name: z.string(), overrides: z.record(z.string(), z.unknown()) }) }),
    tool(async ({ prompt_id }) => { calls.push("status"); if (transientStatusErrors-- > 0) throw Object.assign(new Error("limited"), { status: 429 }); return { prompt_id, status: "success" }; }, { name: "comfy-cloud_get_job_status", description: "Status", schema: z.object({ prompt_id: z.string() }) }),
    tool(async ({ prompt_id }) => ({ prompt_id, urls: Array.from({ length: outputCount }, (_, i) => `https://93.184.215.14/${i}.png`) }), { name: "comfy-cloud_get_output", description: "Output", schema: z.object({ prompt_id: z.string() }) }),
    tool(async ({ prompt_id }) => ({ prompt_id, status: "cancelled" }), { name: "comfy-cloud_cancel_job", description: "Cancel", schema: z.object({ prompt_id: z.string() }) }),
  ];
  const mcp = { tools: async () => tools } as unknown as McpToolset;
  const settings: ImageOptions = { downloadHosts: ["93.184.215.14"], fetch: async () => new Response(new Uint8Array(pixel), { headers: { "content-type": "image/png" } }), ...options };
  const service = (script: AIMessage[]) => new ImageService(new ImageJobStore(db), files, mcp, new ScriptedChatModel(script), settings);
  return { db, jobs, files, calls, service, paid: () => paid, transient: (n: number) => { transientStatusErrors = n; }, settings };
}

describe("durable bounded image execution", () => {
  it("reconstructs the service and completes a persisted provider job without another model or paid call", async () => {
    const f = await fixture();
    const first = await f.service(preparation()).generate(imageRequest.parse({ prompt: "cat" }), config, "first");
    expect(first.status).toBe("queued");
    const result = await f.service([]).status(first.id, config);
    expect(result.status).toBe("completed");
    expect(result.artifacts?.[0]?.generation).toMatchObject({ providerId: "job-1", workflow: "image", attempts: 1 });
    expect(f.paid()).toBe(1);
    expect((await f.jobs.get(ctx, first.id))?.provider_id).toBe("job-1");
  });
  it("streams real coarse progress through the existing graph and checkpoints only artifact references", async () => {
    const f = await fixture();
    const outer = new ScriptedChatModel([plan("image_generate", { prompt: "cat" }), new AIMessage("Obrázek se tvoří.")]);
    const graph = createAgentGraph({ projectId: ctx.project_id, model: outer, tools: imageTools(f.service(preparation()), f.files), checkpointer: new FileSaver(f.db), timezone: "Europe/Prague" });
    const events = [];
    for await (const event of streamRun(graph, ctx, "Nakresli kočku")) events.push(event);
    expect(events).toContainEqual(expect.objectContaining({ type: "image-progress", status: "queued" }));
    expect(events.at(-1)?.type).toBe("done");
    const state = await graph.getState(config);
    expect(JSON.stringify(state.values)).toContain("queued");
    expect(JSON.stringify(state.values)).not.toContain(pixel.toString("base64"));
    expect(f.paid()).toBe(1);
  });
  it("enforces cumulative estimated cost before every paid submission", async () => {
    const f = await fixture({}, 3);
    const rejected = await f.service(preparation()).generate(imageRequest.parse({ prompt: "cat", maxCost: 2 }), config, "over-budget");
    expect(rejected).toMatchObject({ status: "failed", error: "ATTEMPT_OR_COST_LIMIT" });
    expect(f.paid()).toBe(0);
    const missingPrice = await fixture({}, null);
    // Explicitly remove the quote, rather than supplying a fictitious zero price.
    const quote = missingPrice.service(preparation());
    const result = await quote.generate(imageRequest.parse({ prompt: "cat", maxCost: 2 }), config, "unknown-price");
    expect(result).toMatchObject({ status: "failed", error: "COST_ESTIMATE_UNAVAILABLE" });
    expect(missingPrice.paid()).toBe(0);
  });
  it("bounds paid refinements and never returns an invalid transparent image", async () => {
    const f = await fixture({ maxAttempts: 2, maxRefinements: 1 });
    const service = f.service([...preparation(), run()]);
    const first = await service.generate(imageRequest.parse({ prompt: "transparent cat", output: { transparent: true } }), config, "alpha");
    const refined = await service.status(first.id, config);
    expect(refined.status).toBe("queued");
    expect((await f.jobs.get(ctx, first.id))?.provider_id).toBe("job-2");
    expect(await service.status(first.id, config)).toMatchObject({ status: "failed", error: "TRANSPARENCY_MISSING" });
    expect(f.paid()).toBe(2);
    expect(Number((await f.jobs.get(ctx, first.id))?.refinements)).toBe(1);
  });
  it("does not refine when a subsequent paid request would exceed the budget", async () => {
    const f = await fixture({ maxAttempts: 2, maxRefinements: 1 }, 3);
    const service = f.service(preparation());
    const first = await service.generate(imageRequest.parse({ prompt: "transparent cat", maxCost: 5, output: { transparent: true } }), config, "alpha-budget");
    expect(await service.status(first.id, config)).toMatchObject({ status: "failed", error: "TRANSPARENCY_MISSING" });
    expect(f.paid()).toBe(1);
  });
  it("retries only transient read failures and cancels the exact provider job", async () => {
    const f = await fixture(); const service = f.service(preparation());
    const first = await service.generate(imageRequest.parse({ prompt: "cat" }), config, "retry");
    f.transient(1);
    expect((await service.status(first.id, config)).status).toBe("completed");
    expect(f.calls.filter(c => c === "status")).toHaveLength(2);
    expect(f.paid()).toBe(1);
    const second = await f.service(preparation()).generate(imageRequest.parse({ prompt: "cat" }), config, "cancel");
    expect(await service.status(second.id, config, true)).toMatchObject({ status: "cancelled" });
    expect(f.paid()).toBe(2);
  });
  it("uses the API upload fallback for a thread attachment without exposing its bytes to planning", async () => {
    const f = await fixture();
    const vault = new SecretVault(f.db, SecretBox.insecureDev());
    await vault.put("COMFY_API_KEY", "", { value: "private-key", allowedHosts: ["cloud.comfy.org"], description: "test" });
    let uploads = 0;
    f.settings.uploadApi = new ComfyUploadApi(vault, "COMFY_API_KEY", async () => { uploads++; return Response.json({ name: "source.png", subfolder: "" }); });
    await f.files.write({ scope: "temp", threadId: ctx.thread_id }, "source.png", pixel);
    const script = [...preparation().slice(0, 2), plan("comfy-cloud_run_template", { template_name: "image", overrides: { prompt: "cat", image: "source.png" } })];
    const result = await f.service(script).generate(imageRequest.parse({ prompt: "edit cat", operation: "edit", references: [{ path: "source.png", role: "source" }] }), config, "upload");
    expect(result.status).toBe("queued"); expect(uploads).toBe(1); expect(f.paid()).toBe(1);
    expect(String((await f.jobs.get(ctx, result.id))?.context)).not.toContain(pixel.toString("base64"));
  });
  it("stores a predictable game atlas and selected variants across turns", async () => {
    const f = await fixture({}, 1, 2); const service = f.service(preparation());
    const first = await service.generate(imageRequest.parse({ prompt: "two icons", output: { count: 2 }, game: { kind: "spritesheet", frames: ["default", "hover"], columns: 2, cellWidth: 8, cellHeight: 8 } }), config, "sprites");
    const result = await service.status(first.id, config);
    expect(result.status).toBe("completed"); expect(result.artifacts).toHaveLength(3);
    const sheet = result.artifacts![2]!;
    const atlas = JSON.parse((await f.files.read({ scope: "temp", threadId: ctx.thread_id }, String(sheet.atlasPath))).data.toString());
    expect(atlas.frames).toEqual([{ x: 0, y: 0, width: 8, height: 8, name: "default" }, { x: 8, y: 0, width: 8, height: 8, name: "hover" }]);
    await service.select(ctx, first.id, 1);
    expect((await f.jobs.selection(ctx))?.selected_index).toBe(1);
    const edit = await f.service([]).generate(imageRequest.parse({ prompt: "resize selected", operation: "resize", geometry: { scale: 0.5 } }), config, "selected");
    expect(edit).toMatchObject({ status: "completed", parentRevision: first.id });
  });
  it("does not re-execute an already claimed invocation while another worker owns its lease", async () => {
    const f = await fixture();
    const claimed = await f.jobs.claim(ctx, "busy", imageRequest.parse({ prompt: "cat" }));
    expect(await f.jobs.lease(String(claimed.row.id), "worker", 60_000)).toBe(true);
    expect((await f.service(preparation()).generate(imageRequest.parse({ prompt: "cat" }), config, "busy")).status).toBe("planning");
    expect(f.paid()).toBe(0);
  });
});
