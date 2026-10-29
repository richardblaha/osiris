import { serve } from "@hono/node-server";
import { Agent, fetch as undiciFetch } from "undici";
import { loadConfig } from "./config.ts";
import { hostname } from "node:os";
import { cachePrefix, createApp, graphLoader } from "./app.ts";
import { HistoryStore, startRecorder } from "./history.ts";
import { introspection, devVerifier } from "./auth.ts";
import { noCache, redisCache } from "./cache.ts";
import { Kube } from "./sources/kubernetes/kube.ts";
import { loadKubeconfig } from "./sources/kubernetes/kubeconfig.ts";
import { kubernetesSource } from "./sources/kubernetes/source.ts";
import { ClickHouse, Telemetry } from "./telemetry.ts";
import { startTelemetry } from "@osiris/platform/telemetry.ts";

const config = loadConfig();
startTelemetry("osiris-digital-twin");

// The cluster to twin: a kubeconfig (any cluster, its context, its certificate authority) or the pod's own
// ServiceAccount (in the cluster we run in).
const kubeconfig = config.KUBECONFIG ? await loadKubeconfig(config.KUBECONFIG, config.KUBE_CONTEXT) : undefined;
const kubeFetch =
  kubeconfig && (kubeconfig.ca || kubeconfig.insecureTls)
    ? ((url: Parameters<typeof undiciFetch>[0], init: Parameters<typeof undiciFetch>[1]) =>
        undiciFetch(url, {
          ...init,
          dispatcher: new Agent({ connect: { ca: kubeconfig.ca, rejectUnauthorized: !kubeconfig.insecureTls } }),
        })) as unknown as typeof fetch
    : undefined;

// The source adapter; Kubernetes is the one there is (TwinSource in twin.ts is how another one plugs in).
const source = kubernetesSource(
  new Kube({
    apiServer: kubeconfig?.server ?? config.KUBE_API_SERVER,
    tokenPath: kubeconfig?.tokenPath ?? config.KUBE_TOKEN_PATH,
    token: kubeconfig?.token ?? config.KUBE_TOKEN,
    fetchFn: kubeFetch,
  }),
  config.CLUSTER_NAME,
);
const clickhouse = config.CLICKHOUSE_URL ? new ClickHouse(config.CLICKHOUSE_URL, config.CLICKHOUSE_USER, config.CLICKHOUSE_PASSWORD ?? "") : undefined;
const telemetry = clickhouse ? new Telemetry(clickhouse, config.CLICKHOUSE_CLUSTER) : undefined;
const cache = config.REDIS_URL ? redisCache(config.REDIS_URL) : noCache;
const history = config.HISTORY_ENABLED && clickhouse ? new HistoryStore(clickhouse, config.CLUSTER_NAME, source.name) : undefined;

const app = createApp(config, {
  source,
  telemetry,
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
  cache,
  staticDir: config.STATIC_DIR,
  history,
});

// One replica records at a time: the lease is in Redis, named like the twin's cache keys.
if (history) {
  const owner = `${hostname()}:${process.pid}`;
  const lease = `${cachePrefix(config, source)}:recorder`;
  startRecorder({
    history,
    graph: graphLoader(config, { source, telemetry, cache }),
    lease: { hold: (ttl) => cache.claim(lease, owner, ttl) },
    intervalMs: config.HISTORY_INTERVAL_SECONDS * 1000,
  });
}

serve({ fetch: app.fetch, port: config.PORT });
console.log(
  `osiris-digital-twin on :${config.PORT} (cluster ${config.CLUSTER_NAME}${kubeconfig ? ` at ${kubeconfig.server}` : ""}${config.REDIS_URL ? ", cached in Redis" : ""}${history ? `, history every ${config.HISTORY_INTERVAL_SECONDS} s` : ""})`,
);
