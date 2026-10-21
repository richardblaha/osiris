import { readFileSync } from "node:fs";
import { BlockList, isIP } from "node:net";
import { serve } from "@hono/node-server";
import { metrics } from "@opentelemetry/api";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
import { Reader, type CountryResponse } from "mmdb-lib";
import { z } from "zod";
import { startTelemetry } from "@osiris/platform/telemetry.ts";
import { createWebEventsApp, type Outcome, type Site } from "./app.ts";
import { VisitorHasher } from "./visitor.ts";

// The service's own traces, metrics and logs go to the cluster's telemetry like every other service.
startTelemetry("web-events");

const env = z
  .object({
    PORT: z.coerce.number().int().default(8080),
    /** Secret: derives each day's salt for visitor hashes. */
    SALT_SEED: z.string().min(32),
    /** JSON [{ id, hosts }] (ConfigMap). */
    SITES: z.string().default("[]"),
    /** The collector's web analytics receiver (OTLP/HTTP), kept apart from OTEL_EXPORTER_OTLP_ENDPOINT. */
    WEB_EVENTS_OTLP_URL: z.url().default("http://localhost:4320/v1/logs"),
    /** CIDRs of the ingress pods (comma-separated), whose X-Real-IP is believed. */
    TRUSTED_PROXIES: z.string().default("10.0.0.0/8,127.0.0.1/32"),
    /** Cloudflare's addresses (https://www.cloudflare.com/ips/), for the sites behind it: CF-Connecting-IP from these. */
    CDN_PROXIES: z
      .string()
      .default(
        "173.245.48.0/20,103.21.244.0/22,103.22.200.0/22,103.31.4.0/22,141.101.64.0/18,108.162.192.0/18,190.93.240.0/20,188.114.96.0/20,197.234.240.0/22,198.41.128.0/17,162.158.0.0/15,104.16.0.0/13,104.24.0.0/14,172.64.0.0/13,131.0.72.0/22," +
          "2400:cb00::/32,2606:4700::/32,2803:f800::/32,2405:b500::/32,2405:8100::/32,2a06:98c0::/29,2c0f:f248::/32",
      ),
    /** DB-IP Lite or MaxMind GeoLite2 country database; without it, no country. */
    GEOIP_DB: z.string().default("/app/geo/country.mmdb"),
  })
  .parse(process.env);

const sites = z.array(z.object({ id: z.string().min(1), hosts: z.array(z.string().min(1)).min(1) })).parse(JSON.parse(env.SITES)) satisfies Site[];

const blockList = (cidrs: string) => {
  const list = new BlockList();
  for (const cidr of cidrs.split(",").map((c) => c.trim()).filter(Boolean)) {
    const [net, prefix] = cidr.split("/");
    list.addSubnet(net!, Number(prefix), isIP(net!) === 6 ? "ipv6" : "ipv4");
  }
  return list;
};

let country = (_ip: string) => "";
try {
  const reader = new Reader<CountryResponse>(readFileSync(env.GEOIP_DB));
  country = (ip) => reader.get(ip)?.country?.iso_code ?? "";
} catch {
  console.warn(`No GeoIP database at ${env.GEOIP_DB}: events go without a country`);
}

// Web events: one OTLP log record each, batched, to their own receiver.
const provider = new LoggerProvider({
  resource: resourceFromAttributes({ "service.name": "web-events" }),
  processors: [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter({ url: env.WEB_EVENTS_OTLP_URL }), scheduledDelayMillis: 2000 })],
});
const logger = provider.getLogger("web-events");

const meter = metrics.getMeter("web-events");
const received = meter.createCounter("web_events.received", { description: "Events received, by outcome (accepted, bot, dnt, invalid, forbidden, too_large, error)" });
// Accepted events whose IP is private: the ingress doesn't pass the visitor's IP on (hashes and countries are then wrong).
const privateIps = meter.createCounter("web_events.private_ip", { description: "Accepted events with a private client IP" });

const app = createWebEventsApp({
  sites,
  hasher: new VisitorHasher(env.SALT_SEED),
  country,
  emit: (event, attributes) => logger.emit({ body: event, attributes }),
  trustedProxies: blockList(env.TRUSTED_PROXIES),
  cdnProxies: blockList(env.CDN_PROXIES),
  script: readFileSync(new URL("./e.js", import.meta.url), "utf8"),
  count: (outcome: Outcome, privateIp?: boolean) => {
    received.add(1, { outcome });
    if (privateIp) privateIps.add(1);
  },
});

const server = serve({ fetch: app.fetch, port: env.PORT }, ({ port }) => console.log(`web-events listening on :${port}, ${sites.length} sites`));
process.on("SIGTERM", () => server.close(() => void provider.shutdown().finally(() => process.exit(0))));
