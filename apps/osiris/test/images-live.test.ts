import { expect, it } from "vitest";
import { defaultConnector } from "@osiris/core/mcp/toolset.ts";

// Discovery only: no upload, workflow, generation or partner API is invoked.
it.skipIf(process.env.COMFY_LIVE_TEST !== "1")("discovers official Comfy Cloud MCP tools", async () => {
  const key = process.env.COMFY_TEST_API_KEY ?? process.env.COMFY_API_KEY;
  if (!key) throw new Error("Set COMFY_TEST_API_KEY for the opt-in live discovery test");
  const connection = await defaultConnector(false)({ name: "comfy-cloud", url: "https://cloud.comfy.org/mcp", auth: "headers", headers: { "X-API-Key": key } });
  try {
    const { writeFile } = await import("node:fs/promises");
    const { toJsonSchema } = await import("@langchain/core/utils/json_schema");
    await writeFile("/tmp/osiris-comfy-discovered-tools.json", JSON.stringify(connection.tools.map(t => ({ name: t.name, description: t.description, schema: toJsonSchema(t.schema) })), null, 2), { mode: 0o600 });
    expect(connection.tools.some(t => t.name === "comfy-cloud_run_template")).toBe(true);
    expect(connection.tools.some(t => t.name === "comfy-cloud_get_job_status")).toBe(true);
  } finally { await connection.close(); }
}, 30_000);

// Exactly one paid submission, only when separately and explicitly enabled.
it.skipIf(process.env.COMFY_LIVE_GENERATE !== "1")("generates one small image through the native integration", async () => {
  const key = process.env.COMFY_TEST_API_KEY ?? process.env.COMFY_API_KEY;
  if (!key) throw new Error("Set COMFY_TEST_API_KEY securely before enabling the paid test");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { setTimeout: delay } = await import("node:timers/promises");
  const { Records } = await import("@osiris/core/projects/records.ts");
  const { createThread } = await import("@osiris/core/repo/threads.ts");
  const { FileStore } = await import("@osiris/core/files/store.ts");
  const { ImageJobStore } = await import("@osiris/tools-images/store.ts");
  const { ImageService, imageRequest } = await import("@osiris/tools-images/service.ts");
  const { createChatModel } = await import("@osiris/core/agent/model.ts");
  const dir = await mkdtemp(join(tmpdir(), "osiris-comfy-live-"));
  const db = new Records(join(dir, ".osiris"));
  const connection = await defaultConnector(false)({ name: "comfy-cloud", url: "https://cloud.comfy.org/mcp", auth: "headers", headers: { "X-API-Key": key } });
  let completed = false;
  try {
   
    await createThread(db, "live", "live", "web");
    const model = await createChatModel(process.env.LLM_TOOLS_MODEL ?? process.env.LLM_MODEL ?? "mistralai:mistral-small-2603");
    const mcp = { tools: async () => connection.tools };
    const service = new ImageService(new ImageJobStore(db), new FileStore(dir), mcp as import("@osiris/core/mcp/toolset.ts").McpToolset, model, {
      maxAttempts: 1, maxRefinements: 0, maxImages: 1, maxExecutionTimeMs: 600_000,
      downloadHosts: (process.env.IMAGE_DOWNLOAD_HOSTS ?? "cloud.comfy.org,storage.googleapis.com").split(",").map(h => h.trim()),
    });
    const config = { configurable: { project_id: "live", thread_id: "live", user_id: "live", role: "member", channel: "web" } };
    let result = await service.generate(imageRequest.parse({ prompt: "A simple flat blue circle on a white background. Use a fast, economical image template. One image only.", quality: "economical", output: { width: 256, height: 256, count: 1 } }), config, "one-authorized-live-generation");
    const deadline = Date.now() + 540_000;
    while (["queued", "running"].includes(result.status) && Date.now() < deadline) { await delay(3000); result = await service.status(result.id, config); }
    completed = result.status === "completed";
    expect(result.status, `Image pipeline did not complete: ${result.error ?? result.status}`).toBe("completed");
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts?.[0]).toMatchObject({ width: 256, height: 256, mime: "image/png" });
    expect((await db.all<{ attempts: number }>("private/images/jobs")).reduce((n, j) => n + j.value.attempts, 0)).toBe(1);
  } finally {
    await connection.close();
    if (completed) await rm(dir, { recursive: true, force: true });
    else console.info("Live image check retained for reconciliation:", dir);
  }
}, 600_000);

it.skipIf(process.env.COMFY_LIVE_UPLOAD !== "1")("uploads a small reference through the hosted MCP PUT protocol", async () => {
  const key = process.env.COMFY_TEST_API_KEY ?? process.env.COMFY_API_KEY;
  if (!key) throw new Error("Set a Comfy test key securely first");
  const { completeMcpUpload } = await import("@osiris/tools-images/http.ts");
  const connection = await defaultConnector(false)({ name: "comfy-cloud", url: "https://cloud.comfy.org/mcp", auth: "headers", headers: { "X-API-Key": key } });
  try {
    const target = connection.tools.find(t => t.name === "comfy-cloud_upload_file")!;
    const raw = await target.invoke({ file_path: "/osiris/reference-check.png", client_os: "linux" });
    const data = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64");
    const result = await completeMcpUpload(raw, data, "image/png");
    expect(result).toMatchObject({ name: expect.any(String), type: "input" });
  } finally { await connection.close(); }
}, 30_000);
