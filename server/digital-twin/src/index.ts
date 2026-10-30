import { serve } from "@hono/node-server";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { createApp } from "./app.ts";
import { introspection, devVerifier } from "./auth.ts";
import { memoryCache } from "./cache.ts";
import { TwinStore } from "./store.ts";
import { Instances } from "./instances.ts";
import { bootstrapInstance } from "./bootstrap.ts";
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

// Every instance: its source kept in step with SQLite, its changes out as OpenTelemetry events (only when the service
// sends telemetry), read back from the service's ClickHouse.
const recording = !!process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
const instances = new Instances({
  store,
  defaults: { clickhouse, kube: { apiServer: config.KUBE_API_SERVER, tokenPath: config.KUBE_TOKEN_PATH, token: config.KUBE_TOKEN } },
  emit: recording ? eventEmitter("osiris-digital-twin.history") : undefined,
  historyFrom: clickhouse ? { clickhouse, service: config.OTEL_SERVICE_NAME } : undefined,
  intervalMs: config.SYNC_INTERVAL_SECONDS * 1000,
});
await instances.start();

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
  cache: memoryCache(),
  staticDir: config.STATIC_DIR,
});

serve({ fetch: app.fetch, port: config.PORT });
console.log(`osiris-digital-twin on :${config.PORT} (twins: ${instances.list().map((r) => r.record.id).join(", ") || "none"}${recording ? "; history to OpenTelemetry" : ""})`);
