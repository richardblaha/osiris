import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AIMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { Records } from "@osiris/core/projects/records.ts";
import { createThread } from "@osiris/core/repo/threads.ts";
import { FileStore } from "@osiris/core/files/store.ts";
import { ImageJobStore } from "@osiris/tools-images/store.ts";
import { ImageService, imageRequest } from "@osiris/tools-images/service.ts";
import { assembleSprites, inspectImage, transformImage } from "@osiris/tools-images/processing.ts";
import { imageTools } from "@osiris/tools-images/tools.ts";
import type { McpToolset } from "@osiris/core/mcp/toolset.ts";
import { ScriptedChatModel } from "./helpers.ts";

// A real alpha PNG; no external service or paid provider call is used in these tests.
const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64");
const dirs: string[] = [];
const databases: Records[] = [];
afterEach(async () => { databases.splice(0); await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });
const ctx = { thread_id: "thread", project_id: "acme", user_id: "alice", role: "member" as const, channel: "web" as const };
const config = { configurable: ctx };
const plan = (name: string, args: Record<string, unknown>) => new AIMessage({ content: "", tool_calls: [{ id: name, name, args }] });
async function setup(script: AIMessage[] = [], failedSubmit = false) {
  const dir = await mkdtemp(join(tmpdir(), "osiris-images-")); dirs.push(dir);
  const db = new Records(join(dir, ".osiris")); databases.push(db);
  await createThread(db, ctx.user_id, ctx.thread_id, ctx.channel);
  const jobs = new ImageJobStore(db);
  const files = new FileStore(dir);
  const calls: string[] = [];
  const tools = ["search_templates", "get_template_schema", "run_template", "get_job_status", "get_output", "cancel_job"].map(name => tool(async () => {
    calls.push(name);
    if (name === "run_template" && failedSubmit) throw new Error("secret provider failure");
    return JSON.stringify(name === "run_template" ? { status: "queued", job_id: "provider-1" } : name === "get_job_status" ? { status: "completed", job_id: "provider-1" } : name === "get_output" ? { urls: ["https://93.184.215.14/image.png"] } : name === "search_templates" ? { templates: [{ id: "verified-template", name: "verified-template", capabilities: { generate: true, edit: true } }] } : { type: "object", properties: { prompt: { type: "string" } } });
  }, { name: `comfy-cloud_${name}`, description: name, schema: z.object({ template_name: z.string().optional(), overrides: z.record(z.string(), z.unknown()).optional(), prompt: z.string().optional(), job_id: z.string().optional() }) }));
  const mcp = { tools: async () => tools } as unknown as McpToolset;
  const model = new ScriptedChatModel(script);
  const service = new ImageService(jobs, files, mcp, model, { downloadHosts: ["93.184.215.14"], fetch: async () => new Response(new Uint8Array(pixel), { headers: { "content-type": "image/png" } }) });
  return { db, jobs, files, calls, service, model };
}
const submitPlan = () => [plan("comfy-cloud_search_templates", { prompt: "cat" }), plan("comfy-cloud_get_template_schema", { template_name: "verified-template" }), plan("comfy-cloud_run_template", { template_name: "verified-template", overrides: { prompt: "cat" } }), plan("normalize_image_result", { status: "queued", providerId: "provider-1", urls: [] })];

describe("image pipeline", () => {
  it("validates bounded requests and rejects invalid operations", () => {
    expect(imageRequest.parse({ prompt: "cat" }).output.count).toBe(1);
    expect(() => imageRequest.parse({ prompt: "cat", output: { count: 100 } })).toThrow();
    expect(() => imageRequest.parse({ prompt: "cat", operation: "execute_code" })).toThrow();
  });
  it("claims once across concurrent calls and scopes persisted history", async () => {
    const { jobs } = await setup();
    const claims = await Promise.all([jobs.claim(ctx, "same", {}), jobs.claim(ctx, "same", {})]);
    expect(claims.filter(c => c.fresh)).toHaveLength(1);
    expect(await jobs.history({ ...ctx, user_id: "bob" })).toEqual([]);
    expect(await jobs.get({ ...ctx, thread_id: "other" }, String(claims[0]!.row.id))).toBeUndefined();
  });
  it("submits once, reconciles asynchronously, and persists first-class files", async () => {
    const { service, calls, files, jobs } = await setup([...submitPlan(),
      plan("comfy-cloud_get_job_status", { job_id: "provider-1" }),
      plan("normalize_image_result", { status: "completed", providerId: "provider-1", urls: [] }),
      plan("comfy-cloud_get_output", { job_id: "provider-1" }),
      plan("normalize_image_result", { status: "unknown", providerId: null, urls: ["https://93.184.215.14/image.png"] }),
    ]);
    const input = imageRequest.parse({ prompt: "cat" });
    const created = await service.generate(input, config, "call-1");
    expect(created.status).toBe("queued");
    await service.generate(input, config, "call-1");
    expect(calls.filter(c => c === "run_template")).toHaveLength(1);
    const completed = await service.status(created.id!, config) as { status: string; artifacts: { path: string }[] };
    expect(completed.status).toBe("completed");
    expect((await files.read({ scope: "temp", threadId: ctx.thread_id }, completed.artifacts[0]!.path)).data.length).toBeGreaterThan(0);
    expect((await jobs.history(ctx))[0]!.state).toBe("completed");
    expect(await service.status(created.id!, { configurable: { ...ctx, user_id: "bob" } })).toMatchObject({ error: "NOT_FOUND" });
  });
  it("does not resubmit an ambiguous paid request or expose provider secrets", async () => {
    const { service, calls } = await setup(submitPlan(), true);
    const input = imageRequest.parse({ prompt: "cat" });
    const first = await service.generate(input, config, "call-2");
    expect(first.status).toBe("unknown");
    expect(JSON.stringify(first)).not.toContain("secret");
    await service.generate(input, config, "call-2");
    expect(calls.filter(c => c === "run_template")).toHaveLength(1);
  });
  it("refuses unverifiable monetary budgets and edits without a source before submission", async () => {
    const { service, calls } = await setup();
    expect((await service.generate(imageRequest.parse({ prompt: "cat", maxCost: 1 }), config, "budget")).status).toBe("failed");
    expect((await service.generate(imageRequest.parse({ prompt: "darken", operation: "edit" }), config, "edit")).status).toBe("failed");
    expect(calls).toEqual([]);
  });
  it("requires a graph tool call id and registers native tools", async () => {
    const { service, files } = await setup();
    const tools = imageTools(service, files);
    expect(tools.map(t => t.name)).toContain("image_edit");
    expect(await tools.find(t => t.name === "image_generate")!.invoke({ prompt: "cat" }, config)).toContain("TOOL_CALL_ID_REQUIRED");
  });
  it("receives the stable LangGraph tool call identifier through the native tool wrapper", async () => {
    const { service, files, calls } = await setup(submitPlan());
    const target = imageTools(service, files).find(t => t.name === "image_generate")!;
    const response = await target.invoke({ type: "tool_call", name: "image_generate", id: "graph-call", args: { prompt: "cat" } }, config);
    expect(JSON.stringify(response)).toContain("queued");
    await target.invoke({ type: "tool_call", name: "image_generate", id: "graph-call", args: { prompt: "cat" } }, config);
    expect(calls.filter(c => c === "run_template")).toHaveLength(1);
  });
  it("does not poll or resubmit a paid request whose provider identifier was lost", async () => {
    const { service, calls } = await setup(submitPlan(), true);
    const first = await service.generate(imageRequest.parse({ prompt: "cat" }), config, "lost");
    expect(await service.status(first.id!, config)).toMatchObject({ error: "RECONCILIATION_REQUIRED", status: "unknown" });
    expect(calls).not.toContain("get_job_status");
  });
  it("restores revision context from the database for deterministic edits and keeps the original", async () => {
    const { jobs, service, files } = await setup();
    const original = await jobs.claim(ctx, "original", { prompt: "cat" });
    await files.write({ scope: "temp", threadId: ctx.thread_id }, "original.png", pixel);
    await jobs.update(String(original.row.id), "completed", { result: JSON.stringify({ artifacts: [{ path: "original.png" }] }) });
    const resized = await service.generate(imageRequest.parse({ prompt: "make smaller", operation: "resize", output: { width: 2, height: 2 } }), config, "resize-1");
    expect(resized.status).toBe("completed");
    expect((resized as { parentRevision?: string }).parentRevision).toBe(original.row.id);
    expect((await files.read({ scope: "temp", threadId: ctx.thread_id }, "original.png")).data).toEqual(pixel);

    expect((await jobs.history(ctx)).filter(r => r.state === "completed")).toHaveLength(2);
  });
  it("refuses unavailable MCP tools before submitting, and reports unknown capabilities honestly", async () => {
    const { db, files } = await setup();
    const missing = new ImageService(new ImageJobStore(db), files, { tools: async () => [] } as unknown as McpToolset, new ScriptedChatModel([]));
    expect((await missing.capabilities()).transport).toBe("unsupported");
    expect(await missing.generate(imageRequest.parse({ prompt: "cat" }), config, "missing")).toMatchObject({ error: "UNSUPPORTED_TOOL:search_templates" });
  });
  it("rechecks an unconfirmed cancellation and reports an already-completed job accurately", async () => {
    const { service, calls } = await setup([...submitPlan(), plan("comfy-cloud_cancel_job", { job_id: "provider-1" }), plan("normalize_image_result", { status: "unknown", providerId: null, urls: [] })]);
    const created = await service.generate(imageRequest.parse({ prompt: "cat" }), config, "cancel");
    const cancelled = await service.status(created.id!, config, true);
    expect(cancelled.status).toBe("completed");
    expect(calls).toContain("get_job_status");
    expect(calls.filter(c => c === "run_template")).toHaveLength(1);
    expect(calls).toContain("cancel_job");
  });
  it("inspects real images, rejects opaque alpha, resizes and assembles an atlas", async () => {
    const meta = await inspectImage(pixel);
    expect(meta.width).toBe(1);
    await expect(inspectImage(pixel, true)).rejects.toThrow("TRANSPARENCY_MISSING");
    await expect(inspectImage(Buffer.from("not an image"))).rejects.toThrow();
    const resized = await transformImage(pixel, { width: 10, height: 10 });
    expect((await inspectImage(resized)).width).toBe(10);
    const sheet = await assembleSprites([pixel, pixel, pixel], 2, 10, 10, 2);
    expect(sheet.atlas).toMatchObject({ width: 22, height: 22 });
    expect(sheet.atlas.frames[2]).toEqual({ x: 0, y: 12, width: 10, height: 10 });
    expect((await inspectImage(sheet.data, true)).transparent).toBe(true);
  });
});
