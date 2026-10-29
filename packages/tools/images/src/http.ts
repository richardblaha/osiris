import { request } from "node:https";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { SecretVault } from "@osiris/core/vault/vault.ts";
import { assertSafePublicUrl } from "@osiris/core/mcp/url.ts";
import { ImageError } from "./errors.ts";
import { providerData } from "./provider.ts";

/** Exact host allowlist plus DNS-pinned HTTPS prevents redirects, credential forwarding and DNS rebinding. */
export async function downloadImage(raw: string, hosts: string[], max: number, signal?: AbortSignal, fetchFn?: typeof fetch, redirects = 0) {
  const url = new URL(raw);
  if (!hosts.includes(url.hostname) || url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) throw new ImageError("UNTRUSTED_DOWNLOAD_HOST");
  await assertSafePublicUrl(raw);
  if (fetchFn) {
    const res = await fetchFn(raw, { redirect: "manual", signal });
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get("location"); await res.body?.cancel();
      if (!location || redirects >= 3) throw new ImageError("ARTIFACT_REDIRECT_LIMIT");
      return downloadImage(new URL(location, raw).toString(), hosts, max, signal, fetchFn, redirects + 1);
    }
    if (!res.ok || !res.body) throw new ImageError("ARTIFACT_DOWNLOAD_FAILED", true);
    return readBody(res, max);
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true });
  for (const ip of addresses) await assertSafePublicUrl(`https://${ip.family === 6 ? `[${ip.address}]` : ip.address}/`);
  const address = addresses[0];
  if (!address) throw new ImageError("DOWNLOAD_DNS_FAILED", true);
  return new Promise<Buffer>((resolve, reject) => {
    const req = request(url, { signal, family: address.family, lookup: (_hostname, _options, cb) => cb(null, address.address, address.family) }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode ?? 0)) {
        const location = res.headers.location; res.destroy();
        if (!location || redirects >= 3) { reject(new ImageError("ARTIFACT_REDIRECT_LIMIT")); return; }
        downloadImage(new URL(location, raw).toString(), hosts, max, signal, undefined, redirects + 1).then(resolve, reject); return;
      }
      if (res.statusCode !== 200) { res.destroy(); reject(new ImageError(res.statusCode === 403 ? "ARTIFACT_URL_EXPIRED" : "ARTIFACT_DOWNLOAD_FAILED", true)); return; }
      const type = String(res.headers["content-type"] ?? "").split(";")[0];
      if ((type && !["image/png", "image/jpeg", "image/webp", "application/octet-stream"].includes(type)) || Number(res.headers["content-length"] ?? 0) > max) { res.destroy(); reject(new ImageError("INVALID_OR_OVERSIZED_ARTIFACT")); return; }
      const chunks: Buffer[] = []; let bytes = 0;
      res.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > max) res.destroy(new ImageError("ARTIFACT_TOO_LARGE")); else chunks.push(chunk); });
      res.on("error", reject); res.on("end", () => resolve(Buffer.concat(chunks)));
    });
    req.on("error", reject); req.end();
  });
}
async function readBody(res: Response, max: number) {
  const type = res.headers.get("content-type")?.split(";")[0];
  if (type && !["image/png", "image/jpeg", "image/webp", "application/octet-stream"].includes(type)) throw new ImageError("INVALID_IMAGE_MIME");
  if (Number(res.headers.get("content-length") ?? 0) > max) { await res.body?.cancel(); throw new ImageError("ARTIFACT_TOO_LARGE"); }
  const chunks: Uint8Array[] = []; let bytes = 0;
  for await (const chunk of res.body!) { bytes += chunk.length; if (bytes > max) throw new ImageError("ARTIFACT_TOO_LARGE"); chunks.push(chunk); }
  return Buffer.concat(chunks);
}

/** The documented multipart Cloud upload fills the gap when MCP requires a path on another machine. */
export class ComfyUploadApi {
  constructor(private vault: SecretVault, private keyName = "COMFY_API_KEY", private fetchFn: typeof fetch = fetch) {}
  async upload(data: Buffer, name: string, mime: string, signal?: AbortSignal) {
    const endpoint = "https://cloud.comfy.org/api/upload/image";
    const { filled } = await this.vault.fill({ key: `{{secret:${this.keyName}}}` }, { host: "cloud.comfy.org", userId: "" });
    const form = new FormData();
    form.set("image", new Blob([new Uint8Array(data)], { type: mime }), name);
    form.set("type", "input"); form.set("overwrite", "false");
    const response = await this.fetchFn(endpoint, { method: "POST", body: form, headers: { "X-API-Key": filled.key }, redirect: "error", signal });
    if (!response.ok) throw new ImageError(response.status === 401 || response.status === 403 ? "AUTHENTICATION_REQUIRED" : response.status === 429 ? "RATE_LIMIT_OR_SUBSCRIPTION" : "UPLOAD_FAILED", response.status >= 500);
    const value = providerData(await response.json()) as { name?: unknown; subfolder?: unknown; type?: unknown };
    if (typeof value.name !== "string" || value.name.length > 512) throw new ImageError("INVALID_UPLOAD_RESPONSE");
    return { name: value.name, subfolder: typeof value.subfolder === "string" ? value.subfolder : "", type: "input" };
  }
}

/** Hosted MCP upload_file issues a one-use PUT capability. Its shell command is parsed as data, never executed. */
export async function completeMcpUpload(raw: unknown, data: Buffer, mime: string, signal?: AbortSignal, fetchFn: typeof fetch = fetch) {
  const value = providerData(raw);
  if (value && typeof value === "object" && !Array.isArray(value) && typeof (value as { name?: unknown }).name === "string") return value;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const urls = [...text.matchAll(/https:\/\/[^\s<>"'`\)\]]+/g)].map(m => m[0]);
  const capabilities = urls.filter(rawUrl => {
    try { const u = new URL(rawUrl); return u.origin === "https://cloud.comfy.org" && /^\/api\/uploads\/[A-Za-z0-9_-]+$/.test(u.pathname) && !u.username && !u.password; } catch { return false; }
  });
  if (capabilities.length !== 1 || !/\bPUT\b/.test(text)) throw new ImageError("UNSUPPORTED_MCP_UPLOAD_PROTOCOL");
  const response = await fetchFn(capabilities[0]!, { method: "PUT", headers: { "Content-Type": mime }, body: new Uint8Array(data), redirect: "error", signal });
  if (!response.ok) throw new ImageError(response.status === 404 ? "UPLOAD_URL_EXPIRED" : "UPLOAD_FAILED", response.status >= 500);
  const uploaded = await response.json() as { name?: unknown; subfolder?: unknown; type?: unknown };
  if (typeof uploaded.name !== "string" || uploaded.name.length > 512) throw new ImageError("INVALID_UPLOAD_RESPONSE");
  return { name: uploaded.name, subfolder: typeof uploaded.subfolder === "string" ? uploaded.subfolder : "", type: "input" };
}
