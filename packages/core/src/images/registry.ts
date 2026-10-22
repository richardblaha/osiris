import { object, providerData, walkObjects } from "./provider.ts";
import type { ImageRequest } from "./types.ts";

export const capabilityNames = ["generate", "edit", "inpaint", "outpaint", "upscale", "remove_background", "identity", "style", "composition", "typography", "transparency", "seamless"] as const;
export type Capability = typeof capabilityNames[number];
export type Support = "supported" | "unsupported" | "unknown";
export interface ImageCapabilityRecord {
  id: string; name: string; kind: "model" | "workflow";
  capabilities: Record<Capability, Support>;
  maxReferences?: number; estimatedCost?: number; quality?: number; speed?: number; licensing?: string;
  schema?: unknown; description?: string; tags?: string[]; models?: string[]; verifiedAt: number;
}
export function catalogRecords(raw: unknown, kind: "model" | "workflow"): ImageCapabilityRecord[] {
  const records = new Map<string, ImageCapabilityRecord>();
  walkObjects(providerData(raw), value => {
    const id = value.id ?? value.template_id ?? value.model_id ?? value.name;
    const name = value.name ?? value.title ?? id;
    if (typeof id !== "string" || typeof name !== "string" || id.length > 300 || !id) return;
    if (["video", "audio", "3d", "music"].includes(String(value.mediaType ?? value.media_type ?? value.type).toLowerCase())) return;
    const capabilities = Object.fromEntries(capabilityNames.map(k => [k, "unknown"])) as Record<Capability, Support>;
    const declared = value.capabilities;
    for (const key of capabilityNames) {
      if (object(declared) && (declared[key] === true || declared[key] === "supported")) capabilities[key] = "supported";
      else if (object(declared) && (declared[key] === false || declared[key] === "unsupported")) capabilities[key] = "unsupported";
      else if (Array.isArray(declared) && declared.includes(key)) capabilities[key] = "supported";
    }
    const tagCapabilities: Record<string, Capability> = { "text to image": "generate", "image to image": "edit", "image editing": "edit", "inpainting": "inpaint", "outpainting": "outpaint", "image upscale": "upscale", "remove background": "remove_background", "style transfer": "style", "transparent background": "transparency", "seamless": "seamless" };
    if (Array.isArray(value.tags)) for (const tag of value.tags) {
      const capability = typeof tag === "string" ? tagCapabilities[tag.toLowerCase()] : undefined;
      if (capability && capabilities[capability] === "unknown") capabilities[capability] = "supported";
    }
    const numeric = (x: unknown) => typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : undefined;
    records.set(id, { id, name, kind, capabilities, maxReferences: numeric(value.max_references ?? value.maxReferences), estimatedCost: numeric(value.estimated_cost ?? value.estimatedCost), quality: numeric(value.quality_score), speed: numeric(value.speed_score), licensing: typeof value.license === "string" ? value.license.slice(0, 300) : undefined, schema: value.schema, description: typeof value.description === "string" ? value.description.slice(0, 2000) : undefined, tags: Array.isArray(value.tags) ? value.tags.filter((v): v is string => typeof v === "string") : [], models: Array.isArray(value.models) ? value.models.filter((v): v is string => typeof v === "string") : [], verifiedAt: Date.now() });
  });
  return [...records.values()];
}
export function requiredCapabilities(request: ImageRequest): Capability[] {
  const needed: Capability[] = [request.operation === "variations" ? "edit" : request.operation as Capability];
  if (request.output.transparent) needed.push("transparency");
  if (request.validation.seamless) needed.push("seamless");
  if (request.text) needed.push("typography");
  for (const ref of request.references) if (["identity", "style", "composition"].includes(ref.role)) needed.push(ref.role as Capability);
  return [...new Set(needed)].filter(k => capabilityNames.includes(k));
}
export function rankWorkflows(records: ImageCapabilityRecord[], request: ImageRequest) {
  const needed = requiredCapabilities(request);
  return records.filter(r => needed.every(k => r.capabilities[k] !== "unsupported") && (r.maxReferences === undefined || r.maxReferences >= request.references.length))
    .map(record => {
      let score = needed.reduce((sum, key) => sum + (record.capabilities[key] === "supported" ? 10 : 0), 0);
      const discoveryText = [record.name, record.description, ...(record.tags ?? [])].join(" ");
      if (["fast", "economical"].includes(request.quality)) {
        // Ranking hints, not verified capabilities or price claims. No model family/template id is hardcoded.
        if (/fast|turbo|schnell|lightning|efficient/i.test(discoveryText)) score += 5;
        if (/^api_/.test(record.id) || (record.tags ?? []).some(tag => /api|partner/i.test(tag))) score -= 5;
      }
      if (request.quality === "fast") score += record.speed ?? 0;
      else if (request.quality === "economical") score -= record.estimatedCost ?? 0;
      else score += record.quality ?? 0;
      if (request.quality === "precise-edit" && record.capabilities.inpaint === "supported") score += 5;
      if (request.quality === "consistent-style" && record.capabilities.style === "supported") score += 5;
      return { record, score };
    }).sort((a, b) => b.score - a.score).map(r => r.record);
}
