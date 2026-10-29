import { z } from "zod";

const side = z.number().int().min(1).max(8192);
export const imageFile = z.object({ path: z.string().min(1).max(512), scope: z.enum(["temp", "project"]).default("temp") });
export const imageReference = imageFile.extend({ role: z.enum(["source", "identity", "style", "composition", "color", "structure", "texture", "mask"]) });
export const rectangle = z.object({ left: z.number().int().min(0), top: z.number().int().min(0), width: side, height: side });
export const padding = z.object({ top: z.number().int().min(0).max(8192).default(0), bottom: z.number().int().min(0).max(8192).default(0), left: z.number().int().min(0).max(8192).default(0), right: z.number().int().min(0).max(8192).default(0) });
export const imageRequest = z.object({
  prompt: z.string().trim().min(1).max(8000),
  operation: z.enum(["generate", "edit", "variations", "inpaint", "outpaint", "upscale", "remove_background", "resize", "crop", "pad", "convert", "text", "composite"]).default("generate"),
  sourceIndex: z.number().int().min(0).max(63).optional(),
  sourceRevision: z.string().max(100).optional(),
  references: z.array(imageReference).max(5).default([]),
  output: z.object({ width: side.optional(), height: side.optional(), aspectRatio: z.string().regex(/^\d{1,4}:\d{1,4}$/).optional(), format: z.enum(["png", "jpeg", "webp"]).default("png"), transparent: z.boolean().default(false), count: z.number().int().min(1).max(16).default(1) }).default({ format: "png", transparent: false, count: 1 }),
  quality: z.enum(["auto", "best", "fast", "economical", "precise-edit", "consistent-style"]).default("auto"),
  inheritConstraints: z.boolean().default(true).describe("False only when the user explicitly replaces earlier style or preservation instructions"),
  preserve: z.array(z.string().max(500)).max(20).default([]),
  game: z.object({ kind: z.enum(["avatar", "portrait", "icon", "button", "frame", "banknote", "texture", "tile", "spritesheet"]), frames: z.array(z.string().min(1).max(100)).max(16).default([]), states: z.array(z.enum(["default", "hover", "focus", "active", "disabled", "selected"])).max(6).default([]), columns: z.number().int().min(1).max(16).default(4), cellWidth: side.default(256), cellHeight: side.default(256), gap: z.number().int().min(0).max(128).default(0) }).optional(),
  seed: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  maxCost: z.number().nonnegative().optional(),
  geometry: z.object({ scale: z.number().min(0.01).max(8).optional(), crop: rectangle.optional(), region: rectangle.optional(), padding: padding.optional(), background: z.string().regex(/^(#[\da-fA-F]{6}([\da-fA-F]{2})?|transparent)$/).default("transparent"), left: z.number().int().min(0).default(0), top: z.number().int().min(0).default(0) }).optional(),
  text: z.object({ value: z.string().max(1000), region: rectangle, fontSize: z.number().min(1).max(512).default(32), color: z.string().regex(/^#[\da-fA-F]{6}$/).default("#000000"), background: z.string().regex(/^#[\da-fA-F]{6}$/).optional(), align: z.enum(["left", "center", "right"]).default("left") }).optional(),
  validation: z.object({ visual: z.boolean().default(false), requirements: z.array(z.string().max(500)).max(20).default([]), maxOutsideMaskDifference: z.number().min(0).max(1).default(0), seamless: z.boolean().default(false), edgeTolerance: z.number().min(0).max(1).default(0.05), borderSlices: padding.optional() }).default({ visual: false, requirements: [], maxOutsideMaskDifference: 0, seamless: false, edgeTolerance: 0.05 }),
}).superRefine((r, ctx) => {
  if (r.output.width && r.output.height && r.output.width * r.output.height > 40_000_000) ctx.addIssue({ code: "custom", message: "Output exceeds 40 megapixels" });
  if (r.output.transparent && r.output.format === "jpeg") ctx.addIssue({ code: "custom", message: "JPEG cannot preserve transparency" });
  if (r.operation === "text" && !r.text) ctx.addIssue({ code: "custom", message: "Text edit requires text and a region" });
  if (r.operation === "crop" && !r.geometry?.crop) ctx.addIssue({ code: "custom", message: "Crop requires a rectangle" });
  if (r.operation === "pad" && !r.geometry?.padding) ctx.addIssue({ code: "custom", message: "Padding requires margins" });
});
export type ImageRequest = z.infer<typeof imageRequest>;
export type ImageReference = z.infer<typeof imageReference>;
export type ImageStatus = "planning" | "submitting" | "queued" | "running" | "completed" | "failed" | "cancelled" | "unknown";
export interface ImageArtifact { scope: "temp"; path: string; revision: string; mime: string; width: number; height: number; bytes: number; transparent: boolean; [key: string]: unknown }
export interface ImageResult { id: string; status: ImageStatus; artifacts?: ImageArtifact[]; error?: string; recoverable?: boolean; hint?: string; parentRevision?: string; originalRevision?: string; [key: string]: unknown }
export const deterministicOperations = new Set(["resize", "crop", "pad", "convert", "text", "composite"]);
