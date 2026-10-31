import { z } from "zod";

const bool = z.enum(["true", "false", "1", "0"]).optional().transform((v) => v === "true" || v === "1");

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    PORT: z.coerce.number().int().default(3004),
    STATIC_DIR: z.string().optional(),

    // The twins are instances an admin manages in the PWA. When the service starts with none, it makes one of the
    // cluster it runs in (or KUBECONFIG's) from the settings below, named CLUSTER_NAME (also its id, `twin.id` of
    // its history), so a deployment that had one twin keeps it. Later changes to these settings don't touch it.
    CLUSTER_NAME: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/).default("k8s"),
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

    // The twin's definitions: DTDL models (the source's, plus the admins' edits) and the instances' settings,
    // dashboards and saved filters in DATA_DIR/twin.db (SQLite, one writer). The twins' current state and the
    // telemetry the view draws are not stored here — they live in Redis (REDIS_URL), written by the sync every
    // SYNC_INTERVAL_SECONDS, and the warn/error events the collector catches land in its stream. The history goes
    // out as OpenTelemetry events (with the service's telemetry, OTEL_EXPORTER_OTLP_ENDPOINT) and is read back from
    // ClickHouse's otel_logs as OTEL_SERVICE_NAME's.
    DATA_DIR: z.string().default("./data"),
    SYNC_INTERVAL_SECONDS: z.coerce.number().int().min(5).max(3600).default(30),
    OTEL_SERVICE_NAME: z.string().min(1).default("osiris-digital-twin"),
    // Redis: the twins' current state, the view's telemetry, the answers' cache and the collector's warn/error
    // events (the `otel:events` stream), all under REDIS_KEY_PREFIX. Required in production.
    REDIS_URL: z.url().optional(),
    REDIS_KEY_PREFIX: z.string().regex(/^[a-z0-9][a-z0-9:-]{0,39}$/).default("osiris"),
    // The telemetry the view draws is kept this many seconds longer than a sync interval, so a missed round still shows.
    TELEMETRY_TTL_SECONDS: z.coerce.number().int().min(30).max(86_400).optional(),
    // Push the collector's warn/error events to Osiris's agent: each new event (at least EVENTS_PUSH_MIN_SEVERITY,
    // at most EVENTS_PUSH_MAX_PER_MINUTE) becomes a run of thread EVENTS_PUSH_THREAD in project OSIRIS_PROJECT, with
    // EVENTS_PUSH_TOKEN's bearer (a service account's token the gateway accepts). Off without all four.
    EVENTS_PUSH: bool,
    EVENTS_PUSH_THREAD: z.string().min(1).optional(),
    EVENTS_PUSH_TOKEN: z.string().min(1).optional(),
    EVENTS_PUSH_MIN_SEVERITY: z.enum(["warn", "error", "fatal"]).default("error"),
    EVENTS_PUSH_MAX_PER_MINUTE: z.coerce.number().int().min(1).max(600).default(10),

    // Telemetry and history answers are cached for this long.
    CACHE_DATA_TTL_SECONDS: z.coerce.number().int().positive().default(15),

    // Sign-in: osiris-auth (OIDC). The PWA signs in as WEB_CLIENT_ID (public, PKCE); the API introspects tokens as
    // AUTH_CLIENT_ID. Members of AUTH_ADMIN_GROUP see and manage every twin, members of `twin:<id>` see that twin.
    // Without AUTH_URL there is no sign-in.
    AUTH_URL: z.url().optional().transform((v) => v?.replace(/\/$/, "")),
    WEB_CLIENT_ID: z.string().min(1).default("digital-twin"),
    AUTH_CLIENT_ID: z.string().min(1).default("osiris-digital-twin"),
    AUTH_CLIENT_SECRET: z.string().optional(),
    AUTH_ADMIN_GROUP: z.string().min(1).default("admin"),

    // Seals the instances' secrets (kubeconfigs, passwords) in twin.db: 32 bytes, base64 (`openssl rand -base64 32`).
    // Development without it uses a fixed key.
    TWIN_SECRETS_KEY: z.string().optional(),

    // Development only: any bearer token signs in as `dev` (refused in production).
    AUTH_DEV_BYPASS: bool,

    // Osiris: its gateway, where the twin's chat sends the signed-in user's messages (the PWA calls /osiris/api/…),
    // and its project the chat talks to.
    OSIRIS_URL: z.url().optional().transform((v) => v?.replace(/\/$/, "")),
    OSIRIS_PROJECT: z.string().min(1).optional(),

    // Ops: kubectl and ceph for the agents of OPS_PROJECTS (comma-separated; their runtimes prove who they are with
    // their projected token, checked by TokenReview). kubectl uses the token at OPS_KUBE_TOKEN_PATH (the osiris-ops
    // ServiceAccount's), ceph the config and keyring of a secret. A tool whose files are missing is off.
    OPS_PROJECTS: z
      .string()
      .optional()
      .transform((v) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean)),
    OPS_KUBE_TOKEN_PATH: z.string().default("/var/run/secrets/osiris-ops/token"),
    OPS_KUBE_CA_PATH: z.string().default("/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"),
    OPS_CEPH_CONF: z.string().default("/etc/ceph-ops/ceph.conf"),
    OPS_CEPH_KEYRING: z.string().default("/etc/ceph-ops/keyring"),
    OPS_CEPH_USER: z.string().default("client.admin"),
    // Development only: runtimes are `dev-runtime:<project>` (refused in production).
    DEV_RUNTIME_AUTH: bool,
  })
  .superRefine((env, ctx) => {
    const prod = env.NODE_ENV === "production";
    if (prod) {
      if (!env.AUTH_URL?.startsWith("https://")) ctx.addIssue({ code: "custom", path: ["AUTH_URL"], message: "must be set and https in production" });
      if (!env.TWIN_SECRETS_KEY) ctx.addIssue({ code: "custom", path: ["TWIN_SECRETS_KEY"], message: "is required in production" });
      if (!env.AUTH_CLIENT_SECRET) ctx.addIssue({ code: "custom", path: ["AUTH_CLIENT_SECRET"], message: "is required in production" });
      // The cluster can be anywhere (a kubeconfig of another cluster), but its telemetry has to be reachable.
      if (!env.CLICKHOUSE_URL) ctx.addIssue({ code: "custom", path: ["CLICKHOUSE_URL"], message: "is required in production" });
      if (!env.REDIS_URL) ctx.addIssue({ code: "custom", path: ["REDIS_URL"], message: "is required in production" });
      if (env.AUTH_DEV_BYPASS) ctx.addIssue({ code: "custom", path: ["AUTH_DEV_BYPASS"], message: "must not be enabled in production" });
      if (env.DEV_RUNTIME_AUTH) ctx.addIssue({ code: "custom", path: ["DEV_RUNTIME_AUTH"], message: "must not be enabled in production" });
    }
  });

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) throw new Error(`Invalid configuration:\n${z.prettifyError(parsed.error)}`);
  return parsed.data;
}
