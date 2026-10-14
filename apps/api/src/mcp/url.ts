import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

/** Addresses a tenant's MCP URL must not reach: loopback, private, link-local (cloud metadata), CGNAT, ... */
const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["224.0.0.0", 3],
] as const) {
  blocked.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  blocked.addSubnet(net, prefix, "ipv6");
}

function isBlocked(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  if (mapped) return blocked.check(mapped, "ipv4");
  return blocked.check(address, isIP(address) === 6 ? "ipv6" : "ipv4");
}

export class UnsafeUrlError extends Error {}

/**
 * Guards against SSRF: users choose MCP and http_request URLs, and the API runs inside the cluster.
 * Requires https and a hostname that resolves only to public addresses. `allowPrivate` (development only)
 * also permits http and private addresses, for MCP servers on localhost.
 * DNS can still change between this check and the connection (rebinding); the check runs again on every connect.
 */
export async function assertSafePublicUrl(raw: string, { allowPrivate = false } = {}): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError("Neplatná URL");
  }
  if (url.username || url.password) throw new UnsafeUrlError("URL nesmí obsahovat přihlašovací údaje, použij hlavičky");
  if (allowPrivate) {
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new UnsafeUrlError("URL musí být http(s)");
    return url;
  }
  if (url.protocol !== "https:") throw new UnsafeUrlError("URL musí používat https");

  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (!addresses.length) throw new UnsafeUrlError(`Adresu ${host} nelze přeložit`);
  if (addresses.some(isBlocked)) throw new UnsafeUrlError("URL míří do privátní sítě");
  return url;
}
