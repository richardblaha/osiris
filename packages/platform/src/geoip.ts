import { randomUUID } from "node:crypto";
import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { isIP, BlockList } from "node:net";
import { gunzipSync } from "node:zlib";
import { Reader, type CityResponse, type AsnResponse } from "mmdb-lib";

export interface GeoLocation { country: string; region: string; city: string; asn: string; network: string }
export const EMPTY_GEO: GeoLocation = { country: "", region: "", city: "", asn: "", network: "" };
type GeoRecord = CityResponse & AsnResponse;

const privateIps = new BlockList();
for (const [ip, bits] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.168.0.0", 16], ["224.0.0.0", 3]] as const) privateIps.addSubnet(ip, bits, "ipv4");
for (const [ip, bits] of [["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]] as const) privateIps.addSubnet(ip, bits, "ipv6");

/** Local lookups; only monthly public database files are downloaded, never visitors' addresses. */
export class GeoIp {
  private readers: Partial<Record<"city" | "country" | "asn", Reader<GeoRecord>>> = {};
  private refreshing = false;
  constructor(private dir: string, bundledDir = "/app/geo", countryFile?: string) {
    for (const kind of ["country", "city", "asn"] as const) {
      for (const file of [join(dir, `${kind}.mmdb`), ...(kind === "country" && countryFile ? [countryFile] : []), join(bundledDir, `${kind}.mmdb`)]) {
        try { this.readers[kind] = new Reader<GeoRecord>(readFileSync(file)); break; } catch { /* Optional DB: keep unknown fields empty. */ }
      }
    }
  }
  lookup = (raw: string): GeoLocation => {
    const ip = raw.replace(/^::ffff:/i, "");
    if (!isIP(ip) || privateIps.check(ip, isIP(ip) === 6 ? "ipv6" : "ipv4")) return { ...EMPTY_GEO };
    const city = this.readers.city?.get(ip);
    const country = city?.country?.iso_code ?? this.readers.country?.get(ip)?.country?.iso_code ?? "";
    const asn = this.readers.asn?.get(ip);
    return { country, region: city?.subdivisions?.[0]?.names?.en ?? city?.subdivisions?.[0]?.iso_code ?? "", city: city?.city?.names?.en ?? "", asn: asn?.autonomous_system_number ? `AS${asn.autonomous_system_number}` : "", network: asn?.autonomous_system_organization ?? "" };
  };
  async refresh(fetchFn: typeof fetch = fetch, now = new Date()) {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      mkdirSync(this.dir, { recursive: true });
      const month = now.toISOString().slice(0, 7);
      for (const kind of ["city", "asn"] as const) {
        const marker = join(this.dir, `${kind}-${month}.ready`);
        if (existsSync(marker)) continue;
        try {
          const res = await fetchFn(`https://download.db-ip.com/free/dbip-${kind}-lite-${month}.mmdb.gz`, { signal: AbortSignal.timeout(120_000), redirect: "error" });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const chunks: Uint8Array[] = [];
          let size = 0;
          if (!res.body) throw new Error("Empty GeoIP download");
          for await (const chunk of res.body) { size += chunk.length; if (size > 100 * 1024 * 1024) throw new Error("GeoIP download too large"); chunks.push(chunk); }
          const data = gunzipSync(Buffer.concat(chunks), { maxOutputLength: 256 * 1024 * 1024 });
          const reader = new Reader<GeoRecord>(data);
          const path = join(this.dir, `${kind}.mmdb`);
          const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
          try { writeFileSync(temp, data); renameSync(temp, path); }
          finally { rmSync(temp, { force: true }); }
          this.readers[kind] = reader;
          writeFileSync(marker, "ok");
        } catch (err) { console.warn(`GeoIP ${kind} update failed`, err instanceof Error ? err.message : "unknown error"); }
      }
    } catch (err) { console.warn("GeoIP cache unavailable", err instanceof Error ? err.message : "unknown error"); }
    finally { this.refreshing = false; }
  }
}

export function createGeoIp(env: NodeJS.ProcessEnv = process.env) {
  const geo = new GeoIp(env.GEOIP_DIR ?? "/tmp/osiris-geo", env.GEOIP_BUNDLED_DIR ?? "/app/geo", env.GEOIP_DB);
  if (env.GEOIP_AUTO_UPDATE !== "false") {
    void geo.refresh();
    const timer = setInterval(() => void geo.refresh(), 24 * 60 * 60_000);
    timer.unref();
  }
  return geo;
}
