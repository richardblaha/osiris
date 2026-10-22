import { clientIp } from "@osiris/platform/client-ip.ts";
export { clientIp } from "@osiris/platform/client-ip.ts";
import type { GeoLocation } from "@osiris/platform/geoip.ts";
import { BlockList, isIP } from "node:net";
import type { HttpBindings } from "@hono/node-server";
import { Hono } from "hono";
import { z } from "zod";
import { isBot, parseUserAgent, referrerOf, utmOf } from "./enrich.ts";
import type { VisitorHasher } from "./visitor.ts";

/** A site that may send events: its id (`data-site`) and the host names it is served on. */
export interface Site {
  id: string;
  hosts: string[];
}

/** Why an event was not stored; counted in the `web_events.received` metric. */
export type Outcome = "accepted" | "bot" | "dnt" | "invalid" | "forbidden" | "too_large" | "error";

export interface WebEventsDeps {
  sites: Site[];
  hasher: VisitorHasher;
  /** The country (ISO code) of an IP, or "". */
  country: (ip: string) => string;
  geo?: (ip: string) => GeoLocation;
  /** Sends one event on (an OTLP log record); never given the IP. */
  emit: (event: string, attributes: Record<string, string>) => void;
  /** Proxies (the ingress) whose X-Real-IP / X-Forwarded-For is believed. */
  trustedProxies: BlockList;
  /** A CDN in front of some sites (Cloudflare): when the ingress saw one of its addresses, its CF-Connecting-IP is believed. */
  cdnProxies: BlockList;
  script: string;
  count: (outcome: Outcome, privateIp?: boolean) => void;
}

const MAX_BODY = 4096;

/** What e.js sends: short keys keep the script small. */
const payload = z.object({
  s: z.string().min(1).max(100),
  u: z.url().max(2000),
  r: z.string().max(2000).optional(),
  w: z.number().int().min(0).max(20_000).optional(),
  l: z.string().max(35).optional(),
  e: z
    .string()
    .regex(/^[\w .:-]{1,64}$/)
    .default("pageview"),
  p: z
    .record(z.string().regex(/^[\w.-]{1,40}$/), z.union([z.string().max(200), z.number(), z.boolean()]))
    .refine((p) => Object.keys(p).length <= 10, "at most 10 props")
    .optional(),
});

const PRIVATE = new BlockList();
for (const [net, prefix] of [["10.0.0.0", 8], ["172.16.0.0", 12], ["192.168.0.0", 16], ["100.64.0.0", 10], ["127.0.0.0", 8]] as const) PRIVATE.addSubnet(net, prefix, "ipv4");
PRIVATE.addSubnet("fc00::", 7, "ipv6");
PRIVATE.addSubnet("::1", 128, "ipv6");

const family = (ip: string) => (isIP(ip) === 6 ? "ipv6" : "ipv4");
const plain = (ip: string) => ip.replace(/^::ffff:/, "");


export function createWebEventsApp(deps: WebEventsDeps) {
  const hostsOf = new Map(deps.sites.map((s) => [s.id, s.hosts.map((h) => h.toLowerCase())]));
  const app = new Hono<{ Bindings: HttpBindings }>();

  app.get("/healthz", (c) => c.text("ok"));

  app.get("/_e/e.js", (c) =>
    c.body(deps.script, 200, {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "public, max-age=3600",
      "x-content-type-options": "nosniff",
    }),
  );

  app.post("/_e", async (c) => {
    const done = (outcome: Outcome, status: 202 | 204 | 400 | 403 | 413, privateIp?: boolean) => {
      deps.count(outcome, privateIp);
      return c.body(null, status);
    };
    try {
      if (Number(c.req.header("content-length") ?? 0) > MAX_BODY) return done("too_large", 413);
      const text = await c.req.text();
      if (Buffer.byteLength(text) > MAX_BODY) return done("too_large", 413);
      if (c.req.header("dnt") === "1" || c.req.header("sec-gpc") === "1") return done("dnt", 204);
      const userAgent = c.req.header("user-agent") ?? "";
      if (isBot(userAgent)) return done("bot", 204);

      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        return done("invalid", 400);
      }
      const parsed = payload.safeParse(body);
      if (!parsed.success) return done("invalid", 400);
      const e = parsed.data;

      // The site must be known, and both the page and the request on one of its hosts.
      const hosts = hostsOf.get(e.s);
      const url = new URL(e.u);
      const requestHost = (c.req.header("host") ?? "").split(":")[0]!.toLowerCase();
      if (!hosts || !hosts.includes(url.hostname.toLowerCase()) || !hosts.includes(requestHost)) return done("forbidden", 403);

      const ip = clientIp(
        c.env?.incoming?.socket?.remoteAddress ?? "",
        { realIp: c.req.header("x-real-ip"), forwardedFor: c.req.header("x-forwarded-for"), cdnClientIp: c.req.header("cf-connecting-ip") },
        deps.trustedProxies,
        deps.cdnProxies,
      );
      const privateIp = isIP(ip) ? PRIVATE.check(ip, family(ip)) : true;
      const utm = utmOf(url);
      const screen = e.w ?? 0;
      const location = privateIp ? undefined : deps.geo?.(ip);
      deps.emit(e.e, {
        site: e.s,
        event: e.e,
        path: url.pathname.slice(0, 500),
        ...referrerOf(e.r ?? "", hosts, utm),
        ...utm,
        ...location,
        country: privateIp ? "" : location?.country ?? deps.country(ip),
        ...parseUserAgent(userAgent, screen),
        screen: String(screen),
        lang: (e.l ?? "").toLowerCase().slice(0, 10),
        visitor_hash: deps.hasher.hash(e.s, ip, userAgent),
        ...Object.fromEntries(Object.entries(e.p ?? {}).map(([k, v]) => [`prop.${k}`, String(v)])),
      });
      return done("accepted", 202, privateIp);
    } catch (err) {
      console.error("Event failed", (err as Error).message);
      return done("error", 400);
    }
  });

  return app;
}
