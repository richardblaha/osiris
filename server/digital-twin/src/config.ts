import { z } from "zod";

const bool = z.enum(["true", "false", "1", "0"]).optional().transform((v) => v === "true" || v === "1");

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    PORT: z.coerce.number().int().default(3004),
    STATIC_DIR: z.string().optional(),

    // The twin's root label; the cluster's own name in the k8s API has no single place to read it from.
    CLUSTER_NAME: z.string().min(1).default("k8s"),
    // Ceph's managers' Prometheus pages (`http://<host>:9283/metrics`, comma-separated; the active one answers):
    // the twin then shows Ceph's pools and its OSDs (disks) in their nodes.
    CEPH_MANAGERS: z
      .string()
      .optional()
      .transform((v) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean)),

    // The Kubernetes API: the pod's ServiceAccount in the cluster (read-only ClusterRole, deploy/k8s/rbac.yaml), or a
    // kubeconfig of any other cluster: KUBECONFIG is its path (a `:`-separated list takes the first that exists) and
    // KUBE_CONTEXT the context to use (the current one without it). Its user must authenticate with a token.
    KUBE_API_SERVER: z.url().default("https://kubernetes.default.svc"),
    KUBE_TOKEN_PATH: z.string().default("/var/run/secrets/kubernetes.io/serviceaccount/token"),
    // Development only: a token to send instead of the ServiceAccount's or the kubeconfig's.
    KUBE_TOKEN: z.string().optional(),
    KUBECONFIG: z.string().optional(),
    KUBE_CONTEXT: z.string().optional(),

    // The cluster's telemetry (logs, metrics, traces) through ClickHouse's HTTP interface, read-only. Any cluster:
    // CLICKHOUSE_CLUSTER is the `k8s.cluster.name` its collector stamps its telemetry with (the resource/cluster
    // processor, deploy/observability/collector.yaml); without it the queries see every cluster in the database.
    CLICKHOUSE_URL: z.url().optional(),
    CLICKHOUSE_USER: z.string().default("osiris"),
    CLICKHOUSE_PASSWORD: z.string().optional(),
    CLICKHOUSE_CLUSTER: z.string().min(1).optional(),

    // The twin's structure: DTDL models, twins and relationships in DATA_DIR/twin.db (SQLite, one replica), synced
    // from the source every SYNC_INTERVAL_SECONDS. Its history goes out as OpenTelemetry events (with the service's
    // telemetry, OTEL_EXPORTER_OTLP_ENDPOINT) and is read back from ClickHouse's otel_logs as OTEL_SERVICE_NAME's.
    DATA_DIR: z.string().default("./data"),
    SYNC_INTERVAL_SECONDS: z.coerce.number().int().min(5).max(3600).default(30),
    OTEL_SERVICE_NAME: z.string().min(1).default("osiris-digital-twin"),

    // Telemetry and history answers are cached in the process for this long.
    CACHE_DATA_TTL_SECONDS: z.coerce.number().int().positive().default(15),

    // Sign-in: osiris-auth (OIDC). The PWA signs in as WEB_CLIENT_ID (public, PKCE); the API introspects tokens as
    // AUTH_CLIENT_ID and answers only to members of AUTH_REQUIRED_GROUP. Without AUTH_URL there is no sign-in.
    AUTH_URL: z.url().optional().transform((v) => v?.replace(/\/$/, "")),
    WEB_CLIENT_ID: z.string().min(1).default("digital-twin"),
    AUTH_CLIENT_ID: z.string().min(1).default("osiris-digital-twin"),
    AUTH_CLIENT_SECRET: z.string().optional(),
    AUTH_REQUIRED_GROUP: z.string().min(1).default("admin"),

    // Development only: any bearer token signs in as `dev` (refused in production).
    AUTH_DEV_BYPASS: bool,
  })
  .superRefine((env, ctx) => {
    const prod = env.NODE_ENV === "production";
    if (prod) {
      if (!env.AUTH_URL?.startsWith("https://")) ctx.addIssue({ code: "custom", path: ["AUTH_URL"], message: "must be set and https in production" });
      if (!env.AUTH_CLIENT_SECRET) ctx.addIssue({ code: "custom", path: ["AUTH_CLIENT_SECRET"], message: "is required in production" });
      // The cluster can be anywhere (a kubeconfig of another cluster), but its telemetry has to be reachable.
      if (!env.CLICKHOUSE_URL) ctx.addIssue({ code: "custom", path: ["CLICKHOUSE_URL"], message: "is required in production" });
      if (env.AUTH_DEV_BYPASS) ctx.addIssue({ code: "custom", path: ["AUTH_DEV_BYPASS"], message: "must not be enabled in production" });
    }
  });

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) throw new Error(`Invalid configuration:\n${z.prettifyError(parsed.error)}`);
  return parsed.data;
}
