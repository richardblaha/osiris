import { serve } from "@hono/node-server";
import { createClient } from "redis";
import { startTelemetry, telemetryMiddleware } from "@osiris/platform/telemetry.ts";
import { Hono } from "hono";
import { memoryStateStore, redisStateStore } from "../state.ts";
import { alertsApp } from "./app.ts";
import { devCaller, tokenReviewCaller } from "./caller.ts";
import { loadAlertsConfig } from "./config.ts";
import { AlertEngine, memoryAlertStore, redisAlertStore } from "./engine.ts";
import { OsirisClient, osirisInvestigator } from "./osiris.ts";

// The digital twin's alerting: the collector's warn/error events (its twin_events processor's Redis stream) become
// alerts, and Osiris's agent investigates each new one in a conversation of its own, which the twin shows later.
const config = loadAlertsConfig();
startTelemetry(config.OTEL_SERVICE_NAME);

const redis = config.REDIS_URL ? createClient({ url: config.REDIS_URL }) : undefined;
if (redis) {
  redis.on("error", (err) => console.error("Redis error", err));
  await redis.connect();
}
const events = redis ? redisStateStore(redis, config.REDIS_KEY_PREFIX) : memoryStateStore();
const store = redis ? redisAlertStore(redis, config.REDIS_KEY_PREFIX) : memoryAlertStore();
const osiris = new OsirisClient({ url: config.OSIRIS_URL, project: config.OSIRIS_PROJECT, authUrl: config.AUTH_URL, clientId: config.ALERTS_CLIENT_ID, clientSecret: config.ALERTS_CLIENT_SECRET });
const engine = new AlertEngine({
  store,
  investigator: osirisInvestigator(osiris, config.ALERTS_INVESTIGATION_MINUTES * 60_000),
  minSeverity: config.ALERTS_MIN_SEVERITY,
  reopenMs: config.ALERTS_REOPEN_MINUTES * 60_000,
  maxPerHour: config.ALERTS_MAX_PER_HOUR,
  log: (message, err) => console.error(message, err ?? ""),
});

// The stream, read with a consumer group of our own (the twin's other readers keep theirs): one replica, so one
// consumer; an event is acknowledged when read, a failure is logged and the loop goes on.
let stopped = false;
const consumer = `alerts-${process.pid}`;
void (async () => {
  while (!stopped) {
    try {
      for (const e of await events.readNewEvents("twin-alerts", consumer, 50, 5_000)) await engine.handle(e);
    } catch (err) {
      console.error("Reading the events failed", err);
      await new Promise((r) => setTimeout(r, 5_000));
    }
  }
})();

const caller = config.ALERTS_DEV_TOKEN ? devCaller(config.ALERTS_DEV_TOKEN) : tokenReviewCaller({ username: config.ALERTS_CALLER, audience: config.ALERTS_AUDIENCE, apiServer: config.KUBE_API_SERVER });
const app = new Hono().use(telemetryMiddleware()).route("/", alertsApp({ store, caller, messages: (thread) => osiris.messages(thread), resolveMs: config.ALERTS_RESOLVE_MINUTES * 60_000 }));
const server = serve({ fetch: app.fetch, port: config.PORT }, (info) => console.log(`Digital twin alerts on :${info.port}`));

const stop = async () => {
  stopped = true;
  server.close();
  await Promise.allSettled([...engine.pending]);
  await redis?.quit().catch(() => {});
  process.exit(0);
};
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
