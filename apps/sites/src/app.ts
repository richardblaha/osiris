import { Hono } from "hono";
import { fileType } from "@osiris/shared";
import { readAll, type ObjectStore } from "@osiris/platform/objects.ts";
import type { Db } from "@osiris/platform/rqlite.ts";

const SITE_TTL_MS = 60_000;
const CACHE_BYTES = 128 * 1024 * 1024;
const MAX_CACHED_FILE = 2 * 1024 * 1024;

/** Which release a host serves; unknown and unverified hosts are cached too, briefly. */
class HostMap {
  private readonly cache = new Map<string, { at: number; site: { tenant: string; release: string } | null }>();

  constructor(private readonly db: Db) {}

  async lookup(host: string): Promise<{ tenant: string; release: string } | null> {
    const hit = this.cache.get(host);
    if (hit && Date.now() - hit.at < SITE_TTL_MS) return hit.site;
    try {
      const [row] = await this.db.query<{ tenant_id: string; release_id: string | null }>(
        "SELECT d.tenant_id, d.release_id FROM domains d JOIN tenants t ON t.id = d.tenant_id WHERE d.domain = ? AND d.status = 'verified' AND t.status = 'active'",
        [host],
      );
      const site = row?.release_id ? { tenant: row.tenant_id, release: row.release_id } : null;
      if (this.cache.size > 10_000) this.cache.clear();
      this.cache.set(host, { at: Date.now(), site });
      return site;
    } catch (err) {
      // The database is down: keep serving what we knew.
      if (hit) return hit.site;
      throw err;
    }
  }
}

/** Small files of current releases, in memory (releases never change, a new one gets a new id). */
class FileCache {
  private readonly items = new Map<string, Buffer>();
  private bytes = 0;

  get(key: string) {
    const v = this.items.get(key);
    if (v) {
      this.items.delete(key);
      this.items.set(key, v);
    }
    return v;
  }

  set(key: string, data: Buffer) {
    if (data.length > MAX_CACHED_FILE) return;
    this.items.set(key, data);
    this.bytes += data.length;
    for (const [k, v] of this.items) {
      if (this.bytes <= CACHE_BYTES) break;
      this.items.delete(k);
      this.bytes -= v.length;
    }
  }
}

/** The request path as a site path: decoded, no `..`, no hidden names (except `.well-known`), folders → index.html. */
export function sitePath(pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0") || decoded.includes("\\")) return null;
  const parts = decoded.split("/").filter(Boolean);
  for (const [i, p] of parts.entries()) {
    if (p === "." || p === "..") return null;
    if (p.startsWith(".") && !(i === 0 && p === ".well-known")) return null;
  }
  const path = parts.join("/");
  return !path || decoded.endsWith("/") ? (path ? `${path}/index.html` : "index.html") : path;
}

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "strict-transport-security": "max-age=31536000",
  // A tenant's site runs its own scripts, but can't be framed or reach into other origins' storage.
  "content-security-policy": "frame-ancestors 'self'; base-uri 'self'; object-src 'none'",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
};

/**
 * Serves published tenant sites on their custom domains: static files only, GET and HEAD, from the release the
 * domain points to. No cookies, no server-side code, no directory listings.
 */
export function createSitesApp({ db, objects }: { db: Db; objects: ObjectStore }) {
  const hosts = new HostMap(db);
  const files = new FileCache();

  const load = async (key: string): Promise<Buffer | null> => {
    const cached = files.get(key);
    if (cached) return cached;
    const obj = await objects.get(key);
    if (!obj) return null;
    const data = await readAll(obj.body);
    files.set(key, data);
    return data;
  };

  return new Hono()
    .get("/healthz", (c) => c.json({ ok: true }))
    .on(["GET", "HEAD"], "*", async (c) => {
      const host = (c.req.header("host") ?? "").toLowerCase().replace(/:\d+$/, "");
      const site = await hosts.lookup(host);
      if (!site) return c.text("Site not found", 404, SECURITY_HEADERS);
      const path = sitePath(new URL(c.req.url).pathname);
      if (!path) return c.text("Not found", 404, SECURITY_HEADERS);
      const base = `sites/${site.tenant}/${site.release}`;
      let file = path;
      let data = await load(`${base}/${file}`);
      // `/about` may be the folder `about/`.
      if (!data && !fileType(file)) {
        file = `${path}/index.html`;
        data = await load(`${base}/${file}`);
      }
      if (!data) {
        const notFound = await load(`${base}/404.html`);
        if (!notFound) return c.text("Not found", 404, SECURITY_HEADERS);
        const headers = { ...SECURITY_HEADERS, "content-type": "text/html; charset=utf-8" };
        return c.req.method === "HEAD" ? c.body(null, 404, headers) : c.body(new Uint8Array(notFound), 404, headers);
      }
      const type = fileType(file)?.mime ?? "application/octet-stream";
      const text = type.startsWith("text/") || type.endsWith("json") || type.endsWith("javascript") || type.endsWith("xml");
      const headers = {
        ...SECURITY_HEADERS,
        "content-type": text ? `${type}; charset=utf-8` : type,
        "cache-control": file.endsWith(".html") ? "public, max-age=60" : "public, max-age=3600",
        etag: `"${site.release}"`,
      };
      return c.req.method === "HEAD" ? c.body(null, 200, headers) : c.body(new Uint8Array(data), 200, headers);
    })
    .all("*", (c) => c.text("Method not allowed", 405, { ...SECURITY_HEADERS, allow: "GET, HEAD" }));
}
