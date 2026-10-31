import { lookup as dnsLookup } from "node:dns/promises";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { connect, createServer, isIP, type Server, type Socket } from "node:net";
import { isBlockedAddress } from "@osiris/core/mcp/url.ts";

/**
 * The gate of a contained local agent: the agent's container sits on an internal Docker network with no way out, and
 * the gate (on that network and on the host's bridge) is the only door, both ways:
 * - out: an HTTP CONNECT proxy that resolves each name itself and connects only to public addresses (no loopback,
 *   private, link-local/cloud metadata, CGNAT or multicast; nor the host, which is a private address), to the address
 *   it checked, so DNS can't rebind between check and connect. `allow` lists exceptions (`host` or `host:port`).
 * - in: the agent's port, published on the host's 127.0.0.1 only, forwarded to the agent (an internal network can't
 *   publish ports).
 */
export interface GateOptions {
  /** Exceptions to the public-only rule, `host` or `host:port` (e.g. a model server on the computer). */
  allow?: string[];
  lookup?: (host: string) => Promise<string[]>;
  log?: (line: string) => void;
  idleMs?: number;
}

const resolveAll = async (host: string) => (await dnsLookup(host, { all: true })).map((a) => a.address);

/** Parses CONNECT's `host:port` (`[v6]:port` for IPv6). */
export function parseAuthority(authority: string): { host: string; port: number } | undefined {
  const m = /^(?:\[([0-9a-fA-F:.]+)\]|([A-Za-z0-9.-]+)):(\d{1,5})$/.exec(authority);
  if (!m) return undefined;
  const port = Number(m[3]);
  if (port < 1 || port > 65535) return undefined;
  return { host: (m[1] ?? m[2]!).toLowerCase(), port };
}

/** The address to connect to for `host:port`, or why not. */
export async function admit(host: string, port: number, { allow = [], lookup = resolveAll }: GateOptions = {}): Promise<{ address: string } | { refused: string }> {
  const allowed = allow.some((a) => a.toLowerCase() === host || a.toLowerCase() === `${host}:${port}`);
  let addresses: string[];
  try {
    addresses = isIP(host) ? [host] : await lookup(host);
  } catch {
    return { refused: "unresolved" };
  }
  if (!addresses.length) return { refused: "unresolved" };
  if (!allowed && addresses.some(isBlockedAddress)) return { refused: "private address" };
  return { address: addresses[0]! };
}

/** The outbound proxy (CONNECT only: the agent speaks https, TLS, SSH through the tunnel). */
export function createEgressProxy(options: GateOptions = {}): HttpServer {
  const { log = console.log, idleMs = 120_000 } = options;
  const server = createHttpServer((req, res) => {
    // Plain-http proxying would let the agent send cleartext; Osiris's outbound calls are https.
    log(`refused ${req.method} ${req.url}: only CONNECT`);
    res.writeHead(405, { connection: "close" }).end();
  });
  server.on("connect", (req, client: Socket, head: Buffer) => {
    const target = parseAuthority(req.url ?? "");
    const deny = (status: string, why: string) => {
      log(`refused ${req.url}: ${why}`);
      client.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
    };
    if (!target) return deny("400 Bad Request", "not host:port");
    client.on("error", () => client.destroy());
    void admit(target.host, target.port, options).then((verdict) => {
      if ("refused" in verdict) return deny("403 Forbidden", verdict.refused);
      const upstream = connect({ host: verdict.address, port: target.port });
      let established = false;
      upstream.setTimeout(idleMs, () => upstream.destroy());
      client.setTimeout(idleMs, () => client.destroy());
      upstream.once("connect", () => {
        established = true;
        log(`CONNECT ${target.host}:${target.port} (${verdict.address})`);
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      upstream.on("error", (err) => (established ? client.destroy() : deny("502 Bad Gateway", err.message)));
      client.on("close", () => upstream.destroy());
      upstream.on("close", () => client.destroy());
    });
  });
  return server;
}

/** Forwards every connection to `host:port` (the agent's port, from the host's 127.0.0.1). */
export function createForwarder(host: string, port: number): Server {
  return createServer((client) => {
    const upstream = connect({ host, port });
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
    client.pipe(upstream);
    upstream.pipe(client);
  });
}
