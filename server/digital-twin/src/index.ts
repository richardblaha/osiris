import { serve } from "@hono/node-server";
import { loadConfig } from "./config.ts";
import { createApp } from "./app.ts";
import { introspection, devVerifier } from "./auth.ts";
import { noCache, redisCache } from "./cache.ts";
import { Kube } from "./kube.ts";
import { ClickHouse, Telemetry } from "./telemetry.ts";
import { startTelemetry } from "@osiris/platform/telemetry.ts";

const config = loadConfig();
startTelemetry("osiris-digital-twin");

const app = createApp(config, {
  kube: new Kube({ apiServer: config.KUBE_API_SERVER, tokenPath: config.KUBE_TOKEN_PATH, token: config.KUBE_TOKEN }),
  telemetry: config.CLICKHOUSE_URL ? new Telemetry(new ClickHouse(config.CLICKHOUSE_URL, config.CLICKHOUSE_USER, config.CLICKHOUSE_PASSWORD ?? "")) : undefined,
  verifier: config.AUTH_DEV_BYPASS
    ? devVerifier()
    : config.AUTH_URL && config.AUTH_CLIENT_SECRET
      ? introspection({
          url: config.AUTH_URL,
          clientId: config.AUTH_CLIENT_ID,
          clientSecret: config.AUTH_CLIENT_SECRET,
          requiredGroup: config.AUTH_REQUIRED_GROUP,
        })
      : undefined,
  cache: config.REDIS_URL ? redisCache(config.REDIS_URL) : noCache,
  staticDir: config.STATIC_DIR,
});

serve({ fetch: app.fetch, port: config.PORT });
console.log(`osiris-digital-twin on :${config.PORT} (cluster ${config.CLUSTER_NAME}${config.REDIS_URL ? ", cached in Redis" : ""})`);
