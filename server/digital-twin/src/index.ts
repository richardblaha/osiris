import { serve } from "@hono/node-server";
import { join } from "node:path";
import { createClient } from "redis";
import { loadConfig } from "./config.ts";
import { createApp } from "./app.ts";
import { introspection, devVerifier } from "./auth.ts";
import { memoryCache, redisCache } from "./cache.ts";
import { TwinStore } from "./store.ts";
import { memoryStateStore, redisStateStore } from "./state.ts";
import { Instances } from "./instances.ts";
import { bootstrapInstance } from "./bootstrap.ts";
import { startEventPush } from "./events.ts";
import { SecretBox } from "@osiris/platform/secrets.ts";
import { devRuntimeVerifier, tokenReviewVerifier } from "@osiris/platform/runtime-identity.ts";
import { ClickHouse } from "./telemetry.ts";
import { eventEmitter, startTelemetry } from "@osiris/platform/telemetry.ts";

const config = loadConfig();
startTelemetry(config.OTEL_SERVICE_NAME);

const clickhouse = config.CLICKHOUSE_URL ? new ClickHouse(config.CLICKHOUSE_URL, config.CLICKHOUSE_USER, config.CLICKHOUSE_PASSWORD ?? "") : undefined;
const sealer = config.TWIN_SECRETS_KEY ? new SecretBox(config.TWIN_SECRETS_KEY) : SecretBox.insecureDev();
const store = await TwinStore.open(join(config.DATA_DIR, "twin.db"), sealer);
await bootstrapInstance(store, config);

// Redis holds what is read often and changes fast: every instance's current twins, relationships and view telemetry
// (the sync writes them), the answers' cache, and the warn/error events the collector's `twin/events` processor
// catches. Without REDIS_URL (development) everything stays in the process.
const redis = config.REDIS_URL ? createClient({ url: config.REDIS_URL }) : undefined;
if (redis) {
  redis.on("error", (err) => console.error("Redis error", err));
  await redis.connect();
}
const state = redis ? redisStateStore(redis, config.REDIS_KEY_PREFIX) : memoryStateStore();
const cache = redis ? redisCache(redis, `${config.REDIS_KEY_PREFIX}:cache`) : memoryCache();

// Every instance: its definitions in SQLite, its current state kept in step in Redis, its changes out as
// OpenTelemetry events (only when the service sends telemetry), read back from the service's ClickHouse.
const recording = !!process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
const instances = new Instances({
  store,
  state,
  defaults: { clickhouse, kube: { apiServer: config.KUBE_API_SERVER, tokenPath: config.KUBE_TOKEN_PATH, token: config.KUBE_TOKEN } },
  emit: recording ? eventEmitter("osiris-digital-twin.history") : undefined,
  historyFrom: clickhouse ? { clickhouse, service: config.OTEL_SERVICE_NAME } : undefined,
  intervalMs: config.SYNC_INTERVAL_SECONDS * 1000,
  telemetryTtlSeconds: config.TELEMETRY_TTL_SECONDS ?? config.SYNC_INTERVAL_SECONDS * 3,
});
await instances.start();

// The collector's warn/error events pushed to Osiris's agent (a run of the thread in the twin's project).
const stopEventPush =
  config.EVENTS_PUSH && config.OSIRIS_URL && config.OSIRIS_PROJECT && config.EVENTS_PUSH_THREAD && config.EVENTS_PUSH_TOKEN
    ? startEventPush({
        state,
        url: config.OSIRIS_URL,
        project: config.OSIRIS_PROJECT,
        thread: config.EVENTS_PUSH_THREAD,
        token: config.EVENTS_PUSH_TOKEN,
        minSeverity: config.EVENTS_PUSH_MIN_SEVERITY,
        maxPerMinute: config.EVENTS_PUSH_MAX_PER_MINUTE,
      })
    : undefined;

// Ops: kubectl and ceph for the agents of the allowed projects (their runtimes checked by TokenReview).
const ops = config.OPS_PROJECTS.length
  ? {
      projects: config.OPS_PROJECTS,
      identity: config.DEV_RUNTIME_AUTH ? devRuntimeVerifier() : tokenReviewVerifier(),
      tools: {
        kubectl: { server: config.KUBE_API_SERVER, tokenPath: config.OPS_KUBE_TOKEN_PATH, caPath: config.OPS_KUBE_CA_PATH },
        ceph: { confPath: config.OPS_CEPH_CONF, keyringPath: config.OPS_CEPH_KEYRING, user: config.OPS_CEPH_USER },
      },
    }
  : undefined;
const app = createApp(config, {
  ops,
  instances,
  state,
  verifier: config.AUTH_DEV_BYPASS
    ? devVerifier()
    : config.AUTH_URL && config.AUTH_CLIENT_SECRET
      ? introspection({
          url: config.AUTH_URL,
          clientId: config.AUTH_CLIENT_ID,
          clientSecret: config.AUTH_CLIENT_SECRET,
          adminGroup: config.AUTH_ADMIN_GROUP,
        })
      : undefined,
  cache,
  staticDir: config.STATIC_DIR,
});

serve({ fetch: app.fetch, port: config.PORT });
console.log(
  `osiris-digital-twin on :${config.PORT} (twins: ${instances.list().map((r) => r.record.id).join(", ") || "none"}${recording ? "; history to OpenTelemetry" : ""}${redis ? `; state in ${config.REDIS_URL}` : "; state in memory"}${stopEventPush ? "; events pushed to Osiris" : ""})`,
);

process.on("SIGTERM", () => {
  stopEventPush?.();
  instances.stopAll();
  void redis?.quit();
});
