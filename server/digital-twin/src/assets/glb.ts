/** The most bytes a 3D asset may have. */
export const MAX_ASSET_BYTES = 8 * 1024 * 1024;
/** An asset's name: what a model's drawing refers to (`"shape": "gltf", "asset": "<name>"`). */
export const ASSET_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** The glTF extensions a view draws without anything more: a decoder (Draco, meshopt) is refused. */
const EXTENSIONS = /^KHR_(materials_[a-z_]+|texture_transform|mesh_quantization|lights_punctual)$/;

/**
 * What's wrong with a 3D asset (empty: nothing): it must be a binary glTF 2.0 (GLB) that holds everything itself —
 * its first chunk the JSON, its buffers and images inside the file or as data URIs, never a URL the viewer's
 * browser would fetch — and needs no extension the view can't draw.
 */
export function glbProblems(bytes: Uint8Array): string[] {
  if (bytes.length < 20) return ["not a GLB file"];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== 0x46546c67) return ["not a GLB file (glTF binary)"];
  if (view.getUint32(4, true) !== 2) return ["only glTF 2.0"];
  if (view.getUint32(8, true) !== bytes.length) return ["the file's length doesn't match its header"];
  const jsonLength = view.getUint32(12, true);
  if (view.getUint32(16, true) !== 0x4e4f534a || 20 + jsonLength > bytes.length) return ["its first chunk isn't JSON"];
  let gltf: Record<string, unknown>;
  try {
    gltf = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength))) as Record<string, unknown>;
  } catch {
    return ["its JSON chunk isn't valid JSON"];
  }
  const problems: string[] = [];
  const outside = (list: unknown, kind: string) => {
    for (const item of Array.isArray(list) ? list : []) {
      const uri = (item as { uri?: unknown } | null)?.uri;
      if (uri !== undefined && !(typeof uri === "string" && uri.startsWith("data:"))) problems.push(`its ${kind} refer to a file outside it: everything must be inside the GLB`);
    }
  };
  outside(gltf.buffers, "buffers");
  outside(gltf.images, "images");
  for (const ext of [...new Set([...(Array.isArray(gltf.extensionsRequired) ? gltf.extensionsRequired : []), ...(Array.isArray(gltf.extensionsUsed) ? gltf.extensionsUsed : [])])])
    if (typeof ext !== "string" || !EXTENSIONS.test(ext)) problems.push(`it uses the extension ${String(ext)}, which the view can't draw`);
  return [...new Set(problems)];
}
