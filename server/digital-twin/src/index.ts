import { serve } from "@hono/node-server";
import { Agent, fetch as undiciFetch } from "undici";
import { loadConfig } from "./config.ts";
import { createApp } from "./app.ts";
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

const app = createApp(config, {
  // The source adapter; Kubernetes is the one there is (TwinSource in twin.ts is how another one plugs in).
  source: kubernetesSource(
    new Kube({
      apiServer: kubeconfig?.server ?? config.KUBE_API_SERVER,
      tokenPath: kubeconfig?.tokenPath ?? config.KUBE_TOKEN_PATH,
      token: kubeconfig?.token ?? config.KUBE_TOKEN,
      fetchFn: kubeFetch,
    }),
    config.CLUSTER_NAME,
  ),
  telemetry: config.CLICKHOUSE_URL
    ? new Telemetry(new ClickHouse(config.CLICKHOUSE_URL, config.CLICKHOUSE_USER, config.CLICKHOUSE_PASSWORD ?? ""), config.CLICKHOUSE_CLUSTER)
    : undefined,
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
console.log(
  `osiris-digital-twin on :${config.PORT} (cluster ${config.CLUSTER_NAME}${kubeconfig ? ` at ${kubeconfig.server}` : ""}${config.REDIS_URL ? ", cached in Redis" : ""})`,
);
