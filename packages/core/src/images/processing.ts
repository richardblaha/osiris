import sharp from "sharp";
import { setImmediate as yieldToLoop } from "node:timers/promises";

const options = { limitInputPixels: 40_000_000, failOn: "error" as const };
export async function inspectImage(data: Buffer, transparent = false) {
  const image = sharp(data, options);
  const meta = await image.metadata();
  if (!["png", "jpeg", "webp"].includes(meta.format ?? "") || !meta.width || !meta.height || (meta.pages ?? 1) > 1) throw new Error("INVALID_IMAGE");
  // Decode the entire file, also detecting truncated output. An opaque alpha channel is not transparency.
  const stats = await image.stats();
  if (transparent && (!meta.hasAlpha || stats.isOpaque)) throw new Error("TRANSPARENCY_MISSING");
  return { width: meta.width, height: meta.height, format: meta.format!, mime: `image/${meta.format}`, bytes: data.length, transparent: !!meta.hasAlpha && !stats.isOpaque };
}
export async function transformImage(data: Buffer, output: { width?: number; height?: number; format?: "png" | "jpeg" | "webp" }) {
  return sharp(data, options).rotate().resize({ width: output.width, height: output.height, fit: "inside" }).toFormat(output.format ?? "png").toBuffer();
}
export async function assembleSprites(images: Buffer[], columns: number, cellWidth: number, cellHeight: number, gap: number) {
  if (!images.length || images.length > 64 || !Number.isInteger(columns) || columns < 1 || columns > 16 || ![cellWidth, cellHeight].every(n => Number.isInteger(n) && n >= 1 && n <= 2048) || !Number.isInteger(gap) || gap < 0 || gap > 128) throw new Error("INVALID_LAYOUT");
  const width = columns * (cellWidth + gap) - gap;
  const height = Math.ceil(images.length / columns) * (cellHeight + gap) - gap;
  if (width * height > 40_000_000) throw new Error("LAYOUT_TOO_LARGE");
  const frames = images.map((_, i) => ({ x: (i % columns) * (cellWidth + gap), y: Math.floor(i / columns) * (cellHeight + gap), width: cellWidth, height: cellHeight }));
  const composite = await Promise.all(images.map(async (data, i) => ({ input: await sharp(data, options).resize(cellWidth, cellHeight, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer(), left: frames[i]!.x, top: frames[i]!.y })));
  const data = await sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite(composite).png().toBuffer();
  return { data, atlas: { width, height, frames } };
}

export async function pixels(data: Buffer) {
  const { data: raw, info } = await sharp(data, options).rotate().toColourspace("srgb").ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data: raw, width: info.width, height: info.height };
}
async function rgbaPng(data: Buffer, width: number, height: number) {
  return sharp(data, { raw: { width, height, channels: 4 } }).png().toBuffer();
}
export async function maskPixels(mask: Buffer, width: number, height: number) {
  const meta = await sharp(mask, options).metadata();
  if (meta.width !== width || meta.height !== height) throw new Error("MASK_DIMENSIONS_MISMATCH");
  // Explicit, predictable semantics: white edits, black preserves. Alpha is not inferred as a second mask.
  return sharp(mask, options).removeAlpha().greyscale().raw().toBuffer();
}
export async function maskedComposite(source: Buffer, edited: Buffer, mask: Buffer) {
  const a = await pixels(source), b = await pixels(edited);
  if (a.width !== b.width || a.height !== b.height) throw new Error("EDIT_DIMENSIONS_MISMATCH");
  const m = await maskPixels(mask, a.width, a.height);
  const out = Buffer.alloc(a.data.length);
  for (let p = 0; p < m.length; p++) {
    if (p && (p & 0x3ffff) === 0) await yieldToLoop();
    for (let c = 0; c < 4; c++) out[p * 4 + c] = Math.round((a.data[p * 4 + c]! * (255 - m[p]!) + b.data[p * 4 + c]! * m[p]!) / 255);
  }
  return rgbaPng(out, a.width, a.height);
}
export async function compareImages(source: Buffer, edited: Buffer, mask?: Buffer) {
  const a = await pixels(source), b = await pixels(edited);
  if (a.width !== b.width || a.height !== b.height) throw new Error("COMPARE_DIMENSIONS_MISMATCH");
  const m = mask ? await maskPixels(mask, a.width, a.height) : undefined;
  let difference = 0, maxDifference = 0, changedPixels = 0, protectedPixels = 0;
  for (let p = 0; p < a.width * a.height; p++) {
    if (p && (p & 0x3ffff) === 0) await yieldToLoop();
    if (m && m[p] !== 0) continue;
    protectedPixels++;
    let changed = false;
    for (let c = 0; c < 4; c++) {
      const delta = Math.abs(a.data[p * 4 + c]! - b.data[p * 4 + c]!);
      difference += delta;
      maxDifference = Math.max(maxDifference, delta);
      changed ||= delta !== 0;
    }
    if (changed) changedPixels++;
  }
  return { changedPixels, protectedPixels, meanDifference: protectedPixels ? difference / (protectedPixels * 4 * 255) : 0, maxDifference: maxDifference / 255 };
}
export async function edgeContinuity(data: Buffer) {
  const p = await pixels(data);
  let horizontal = 0, vertical = 0;
  for (let y = 0; y < p.height; y++) for (let c = 0; c < 4; c++) horizontal += Math.abs(p.data[y * p.width * 4 + c]! - p.data[(y * p.width + p.width - 1) * 4 + c]!);
  for (let x = 0; x < p.width; x++) for (let c = 0; c < 4; c++) vertical += Math.abs(p.data[x * 4 + c]! - p.data[((p.height - 1) * p.width + x) * 4 + c]!);
  return { horizontal: horizontal / (p.height * 4 * 255), vertical: vertical / (p.width * 4 * 255) };
}
const escapeXml = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);
export async function editTextImage(data: Buffer, text: import("./types.ts").ImageRequest["text"]) {
  if (!text) throw new Error("TEXT_REGION_REQUIRED");
  const meta = await inspectImage(data);
  const r = text.region;
  if (r.left + r.width > meta.width || r.top + r.height > meta.height) throw new Error("TEXT_REGION_OUT_OF_BOUNDS");
  const anchor = text.align === "center" ? "middle" : text.align === "right" ? "end" : "start";
  const x = text.align === "center" ? r.width / 2 : text.align === "right" ? r.width : 0;
  // Only escaped text and validated colours/numbers enter this SVG. No external resources or SVG input.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${r.width}" height="${r.height}">${text.background ? `<rect width="100%" height="100%" fill="${text.background}"/>` : ""}<text x="${x}" y="50%" dominant-baseline="central" text-anchor="${anchor}" font-family="sans-serif" font-size="${text.fontSize}" fill="${text.color}">${escapeXml(text.value)}</text></svg>`;
  const region = await sharp(Buffer.from(svg)).png().toBuffer();
  return sharp(data, options).composite([{ input: region, left: r.left, top: r.top }]).png().toBuffer();
}
export async function processImage(data: Buffer, request: import("./types.ts").ImageRequest, overlay?: Buffer) {
  const { operation, geometry: g, output } = request;
  const meta = await inspectImage(data);
  let image = sharp(data, options).rotate();
  if (operation === "text") return editTextImage(data, request.text);
  if (operation === "crop") {
    const r = g?.crop;
    if (!r || r.left + r.width > meta.width || r.top + r.height > meta.height) throw new Error("CROP_OUT_OF_BOUNDS");
    image = image.extract(r);
  } else if (operation === "pad") {
    if (!g?.padding) throw new Error("PADDING_REQUIRED");
    const { top, bottom, left, right } = g.padding;
    if ((meta.width + left + right) * (meta.height + top + bottom) > 40_000_000) throw new Error("LAYOUT_TOO_LARGE");
    image = image.extend({ top, bottom, left, right, background: g.background });
  } else if (operation === "composite") {
    if (!overlay) throw new Error("OVERLAY_REQUIRED");
    const over = await inspectImage(overlay);
    if ((g?.left ?? 0) + over.width > meta.width || (g?.top ?? 0) + over.height > meta.height) throw new Error("OVERLAY_OUT_OF_BOUNDS");
    image = image.composite([{ input: overlay, left: g?.left ?? 0, top: g?.top ?? 0 }]);
  } else if (operation === "resize") {
    const width = output.width ?? (g?.scale ? Math.max(1, Math.round(meta.width * g.scale)) : undefined);
    const height = output.height ?? (g?.scale ? Math.max(1, Math.round(meta.height * g.scale)) : undefined);
    if (!width && !height) throw new Error("RESIZE_DIMENSIONS_REQUIRED");
    if ((width ?? meta.width) * (height ?? meta.height) > 40_000_000) throw new Error("LAYOUT_TOO_LARGE");
    image = image.resize({ width, height, fit: "fill" });
  }
  return image.png().toBuffer();
}
export async function restoreOutpaintSource(generated: Buffer, source: Buffer, padding: { top: number; left: number; right: number; bottom: number }) {
  const src = await inspectImage(source), out = await inspectImage(generated);
  if (out.width !== src.width + padding.left + padding.right || out.height !== src.height + padding.top + padding.bottom) throw new Error("OUTPAINT_DIMENSIONS_MISMATCH");
  // Raw pixel copy preserves fully transparent pixels as well as visible ones.
  const a = await pixels(source), b = await pixels(generated);
  for (let y = 0; y < a.height; y++) a.data.copy(b.data, ((y + padding.top) * b.width + padding.left) * 4, y * a.width * 4, (y + 1) * a.width * 4);
  return rgbaPng(b.data, b.width, b.height);
}
export function borderImageMetadata(width: number, height: number, slices: { top: number; right: number; bottom: number; left: number }) {
  if (slices.top + slices.bottom >= height || slices.left + slices.right >= width) throw new Error("INVALID_BORDER_SLICES");
  return { slices, css: { borderImageSlice: `${slices.top} ${slices.right} ${slices.bottom} ${slices.left} fill`, borderImageRepeat: "stretch" } };
}

export async function rectangleMask(width: number, height: number, region: { left: number; top: number; width: number; height: number }) {
  if (width * height > 40_000_000 || region.left + region.width > width || region.top + region.height > height) throw new Error("MASK_REGION_OUT_OF_BOUNDS");
  return sharp({ create: { width, height, channels: 3, background: "black" } }).composite([{ input: { create: { width: region.width, height: region.height, channels: 3, background: "white" } }, left: region.left, top: region.top }]).png().toBuffer();
}
