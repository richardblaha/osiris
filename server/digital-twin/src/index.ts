import { serve } from "@hono/node-server";
import { Agent, fetch as undiciFetch } from "undici";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { createApp } from "./app.ts";
import { HistoryLog, HistoryReader } from "./history.ts";
import { introspection, devVerifier } from "./auth.ts";
import { memoryCache } from "./cache.ts";
import { TwinStore } from "./store.ts";
import { startSync } from "./sync.ts";
import { Kube } from "./sources/kubernetes/kube.ts";
import { loadKubeconfig } from "./sources/kubernetes/kubeconfig.ts";
import { kubernetesSource } from "./sources/kubernetes/source.ts";
import { ClickHouse, Telemetry } from "./telemetry.ts";
import { eventEmitter, startTelemetry } from "@osiris/platform/telemetry.ts";

const config = loadConfig();
startTelemetry(config.OTEL_SERVICE_NAME);

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
  { cephManagers: config.CEPH_MANAGERS },
);
const clickhouse = config.CLICKHOUSE_URL ? new ClickHouse(config.CLICKHOUSE_URL, config.CLICKHOUSE_USER, config.CLICKHOUSE_PASSWORD ?? "") : undefined;
const telemetry = clickhouse ? new Telemetry(clickhouse, config.CLICKHOUSE_CLUSTER) : undefined;

// The structure in SQLite, kept in step with the source; its changes go out as OpenTelemetry events (only when the
// service sends telemetry) and come back from ClickHouse's otel_logs.
const store = await TwinStore.open(join(config.DATA_DIR, "twin.db"));
const recording = !!process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
await startSync({
  source,
  store,
  history: recording ? new HistoryLog(eventEmitter("osiris-digital-twin.history"), config.CLUSTER_NAME, source.name) : undefined,
  intervalMs: config.SYNC_INTERVAL_SECONDS * 1000,
});

const app = createApp(config, {
  source,
  store,
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
  cache: memoryCache(),
  staticDir: config.STATIC_DIR,
  history: clickhouse ? new HistoryReader(clickhouse, config.CLUSTER_NAME, config.OTEL_SERVICE_NAME) : undefined,
});

serve({ fetch: app.fetch, port: config.PORT });
console.log(
  `osiris-digital-twin on :${config.PORT} (cluster ${config.CLUSTER_NAME}${kubeconfig ? ` at ${kubeconfig.server}` : ""}${recording ? ", history to OpenTelemetry" : ""})`,
);
