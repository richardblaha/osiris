import { ImageError } from "./errors.ts";
import type { ImageStatus } from "./types.ts";

export type JsonObject = Record<string, unknown>;
export function object(value: unknown): value is JsonObject { return !!value && typeof value === "object" && !Array.isArray(value); }
/** Decode MCP structured content, text JSON and LangChain ToolMessages without executing provider commands. */
export function providerData(value: unknown): unknown {
  if (typeof value === "string") {
    if (value.length > 2_000_000) throw new ImageError("PROVIDER_RESPONSE_TOO_LARGE");
    try { return JSON.parse(value); } catch { return value; }
  }
  if (object(value)) {
    if (value.type === "image" || value.type === "audio") return { type: value.type, mimeType: value.mimeType };
    if (value.isError === true) {
      const error = JSON.stringify(value).toLowerCase();
      if (/insufficient.credit|insufficient.balance/.test(error)) throw new ImageError("INSUFFICIENT_CREDITS");
      if (/unauthorized|unauthenticated|permission.denied/.test(error)) throw new ImageError("AUTHENTICATION_REQUIRED");
      if (/rate.limit|queue.full/.test(error)) throw new ImageError("RATE_LIMIT_OR_SUBSCRIPTION", true);
      throw new ImageError("PROVIDER_REJECTED_REQUEST");
    }
    if (value.structuredContent !== undefined) return providerData(value.structuredContent);
    if (value.content !== undefined) return providerData(value.content);
    if (value.type === "text" && typeof value.text === "string") return providerData(value.text);
  }
  return Array.isArray(value) ? value.map(providerData) : value;
}
export function walkObjects(value: unknown, visit: (value: JsonObject) => void, depth = 0) {
  if (depth > 16) return;
  if (Array.isArray(value)) value.slice(0, 1000).forEach(v => walkObjects(v, visit, depth + 1));
  else if (object(value)) { visit(value); Object.values(value).forEach(v => walkObjects(v, visit, depth + 1)); }
}
const statuses: Record<string, ImageStatus> = {
  queued: "queued", submitted: "queued", pending: "queued", queued_waiting: "queued",
  in_progress: "running", queued_limited: "queued", preparing: "running", executing: "running", running: "running", cancel_requested: "running",
  success: "completed", succeeded: "completed", completed: "completed", finished: "completed",
  failed: "failed", error: "failed", non_retryable_error: "failed", lost: "failed", cancelled: "cancelled", canceled: "cancelled",
};
export interface ProviderFacts { status: ImageStatus; providerId?: string; urls: string[]; model?: string; workflow?: string; seed?: number; cost?: number; progress?: { value: number; max: number }; batchId?: string; jobIds?: string[]; errorCode?: string; billed?: boolean | "unknown" }
export function providerFacts(raw: unknown): ProviderFacts {
  const data = providerData(raw);
  const facts: ProviderFacts = { status: "unknown", urls: [] };
  const ids = new Set<string>();
  const urls = new Set<string>();
  let batch: Record<string, unknown> | undefined;
  const seenStates = new Set<ImageStatus>();
  walkObjects(data, v => {
    if (typeof v.batch_id === "string" && /^[\w-]{1,200}$/.test(v.batch_id)) { facts.batchId = v.batch_id; batch = v; }
    for (const key of ["prompt_id", "job_id", "jobId", "promptId"]) if (typeof v[key] === "string" && /^[\w-]{1,200}$/.test(v[key] as string)) ids.add(v[key] as string);
    if (typeof v.status === "string" && statuses[v.status.toLowerCase()]) seenStates.add(statuses[v.status.toLowerCase()]!);
    if (v.billed === true || v.billed === false || v.billed === "unknown") facts.billed = v.billed;
    if (object(v.error) && typeof v.error.message === "string") {
      const message = v.error.message.toLowerCase();
      facts.errorCode = /did not generate an image|no image|empty image/.test(message) ? "MODEL_RETURNED_NO_IMAGE" : /insufficient.*credit|balance/.test(message) ? "INSUFFICIENT_CREDITS" : /invalid|unsupported|required|dimension|resolution|size/.test(message) ? "INVALID_PROVIDER_INPUT" : "PROVIDER_EXECUTION_FAILED";
    }
    if (v.completed === true && !v.error) seenStates.add("completed");
    for (const key of ["model", "model_id", "workflow_id", "template_id"]) if (typeof v[key] === "string") {
      if (key.startsWith("model")) facts.model = String(v[key]).slice(0, 200); else facts.workflow = String(v[key]).slice(0, 200);
    }
    if (typeof v.seed === "number" && Number.isSafeInteger(v.seed)) facts.seed = v.seed;
    if (typeof v.cost === "number" && v.cost >= 0) facts.cost = v.cost;
    if (typeof v.value === "number" && typeof v.max === "number" && v.max > 0 && v.value >= 0 && v.value <= v.max) facts.progress = { value: v.value, max: v.max };
    for (const [key, item] of Object.entries(v)) {
      if (/^(url|download_url|downloadUrl|download_link|signed_url|output_url)$/.test(key) && typeof item === "string" && item.startsWith("https://")) urls.add(item);
      if (key === "urls" && Array.isArray(item)) for (const url of item) if (typeof url === "string" && url.startsWith("https://")) urls.add(url);
    }
  });
  // Documented MCP output can be a curl command or HTML block. Only extract the literal HTTPS URL.
  const text = typeof data === "string" ? data : JSON.stringify(data);
  for (const match of text.matchAll(/https:\/\/[^\s<>"'`\)\]]+/g)) {
    const url = match[0];
    if (/https:\/\/cloud\.comfy\.org\/api\/s\//.test(url) || /([?&](X-Goog-Signature|X-Amz-Signature|Signature|token)=)|\.(png|jpe?g|webp)(\?|$)/i.test(url)) urls.add(url);
  }
  const textId = /(?:prompt_id|job_id)\s*[=:]\s*["']?([\w-]{1,200})/.exec(text)?.[1];
  if (textId) ids.add(textId);
  if (facts.batchId) {
    facts.jobIds = [...ids];
    walkObjects(batch, value => { if (Array.isArray(value.jobs)) for (const job of value.jobs) if (object(job) && typeof job.id === "string") facts.jobIds!.push(job.id); });
    facts.jobIds = [...new Set(facts.jobIds)];
  }
  if (!facts.batchId && ids.size > 1) throw new ImageError("AMBIGUOUS_PROVIDER_ID");
  facts.providerId = facts.batchId ?? [...ids][0];
  facts.status = ["failed", "cancelled", "completed", "running", "queued"].find(s => seenStates.has(s as ImageStatus)) as ImageStatus ?? (facts.providerId ? "queued" : "unknown");
  if (batch && object(batch.summary)) {
    if (typeof batch.summary.pending === "number" && batch.summary.pending > 0) facts.status = "running";
    else if (batch.summary.pending === 0 && typeof batch.summary.failed === "number" && batch.summary.failed > 0) facts.status = "failed";
    else if (batch.summary.pending === 0 && typeof batch.summary.ready === "number" && batch.summary.ready > 0) facts.status = "completed";
  }
  if (batch && Array.isArray(batch.jobs) && batch.jobs.length && batch.jobs.every(job => object(job) && ["cancelled", "canceled"].includes(String(job.raw_status ?? job.status)))) facts.status = "cancelled";
  facts.urls = [...urls];
  if (facts.urls.length > 64) throw new ImageError("TOO_MANY_PROVIDER_OUTPUTS");
  return facts;
}
