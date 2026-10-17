import { createServer } from "node:http";
import { z } from "zod";
import { InternalSigner } from "@osiris/platform/internal-auth.ts";
import { deriveTenantKey } from "@osiris/platform/tenant-keys.ts";
import { Kube } from "./kube.ts";
import { httpRuntimeProbe, Reconciler, runtimeUrl } from "./reconciler.ts";
import type { TenantResource } from "./resources.ts";

const pem = z.string().transform((v) => v.replace(/\\n/g, "\n"));
const env = z
  .object({
    NAMESPACE: z.string().default("osiris"),
    RUNTIME_IMAGE: z.string().min(1),
    IMAGE_PULL_SECRET: z.string().optional(),
    STORAGE_CLASS: z.string().default("civo-volume"),
    CONTROL_URL: z.url(),
    GOTENBERG_URL: z.url().optional(),
    INTERNAL_JWT_PRIVATE_KEY: pem,
    INTERNAL_JWT_PUBLIC_KEY: pem,
    SECRETS_MASTER_KEY: z.string().min(1),
    SITES_SERVICE: z.string().default("sites"),
    SITES_PORT: z.coerce.number().int().default(8080),
    CLUSTER_ISSUER: z.string().default("letsencrypt"),
    INGRESS_CLASS: z.string().default("traefik"),
    SITES_MIDDLEWARE: z.string().optional(),
    RESYNC_SECONDS: z.coerce.number().int().positive().default(60),
    HEALTH_PORT: z.coerce.number().int().default(8081),
  })
  .parse(process.env);

/** Runtime settings passed through from the operator's own environment: RUNTIME_* (plain) and RUNTIME_SECRET_* (keys). */
const passThrough = (prefix: string) =>
  Object.fromEntries(
    Object.entries(process.env)
      .filter(([k, v]) => k.startsWith(prefix) && v)
      .map(([k, v]) => [k.slice(prefix.length), v!]),
  );
const runtimeSecrets = passThrough("RUNTIME_SECRET_");
const runtimeEnv = passThrough("RUNTIME_ENV_");

const kube = new Kube();
const pull = env.IMAGE_PULL_SECRET ? await kube.get<{ data: Record<string, string> }>("Secret", env.NAMESPACE, env.IMAGE_PULL_SECRET) : null;
const signer = new InternalSigner(env.INTERNAL_JWT_PRIVATE_KEY, "operator");

const reconciler = new Reconciler(
  kube,
  {
    namespace: env.NAMESPACE,
    runtimeImage: env.RUNTIME_IMAGE,
    imagePullSecret: pull?.data[".dockerconfigjson"] ? { dockerconfigjson: pull.data[".dockerconfigjson"] } : undefined,
    storageClass: env.STORAGE_CLASS,
    controlUrl: env.CONTROL_URL,
    gotenbergUrl: env.GOTENBERG_URL,
    internalPublicKey: env.INTERNAL_JWT_PUBLIC_KEY,
    runtimeEnv,
    runtimeSecrets,
    tenantSecretsKey: (tenant) => deriveTenantKey(env.SECRETS_MASTER_KEY, tenant),
    sites: { service: env.SITES_SERVICE, port: env.SITES_PORT, clusterIssuer: env.CLUSTER_ISSUER, ingressClass: env.INGRESS_CLASS, middleware: env.SITES_MIDDLEWARE },
  },
  httpRuntimeProbe(signer, runtimeUrl),
);

// One reconcile at a time; a tenant changed while it's being reconciled is queued again.
const queue = new Set<string>();
let busy = false;
let lastSuccess = Date.now();
const drain = async () => {
  if (busy) return;
  busy = true;
  try {
    while (queue.size) {
      const name = queue.values().next().value!;
      queue.delete(name);
      const t = await kube.get<TenantResource>("Tenant", env.NAMESPACE, name).catch(() => null);
      if (t) await reconciler.reconcile(t).catch((err) => console.error(`Tenant ${name}: reconcile failed`, err));
    }
    lastSuccess = Date.now();
  } finally {
    busy = false;
  }
};
const enqueue = (name: string) => {
  queue.add(name);
  void drain();
};

// Watch for changes (wake requests must apply within seconds), and resync everything regularly (idle checks).
const abort = new AbortController();
(async () => {
  while (!abort.signal.aborted) {
    try {
      await kube.watch("Tenant", env.NAMESPACE, (_type, obj) => enqueue(obj.metadata.name), abort.signal);
    } catch (err) {
      if (!abort.signal.aborted) console.error("Tenant watch failed, reconnecting", (err as Error).message);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
})();
const resync = async () => {
  try {
    for (const t of await kube.list<TenantResource>("Tenant", env.NAMESPACE)) queue.add(t.metadata.name);
    void drain();
  } catch (err) {
    console.error("Resync failed", err);
  }
};
await resync();
const timer = setInterval(resync, env.RESYNC_SECONDS * 1000);

// Liveness: the reconcile loop made progress recently.
const health = createServer((req, res) => {
  const ok = Date.now() - lastSuccess < 10 * env.RESYNC_SECONDS * 1000;
  res.writeHead(ok ? 200 : 503, { "content-type": "application/json" }).end(JSON.stringify({ ok }));
}).listen(env.HEALTH_PORT);
console.log(`Operator watching Tenants in ${env.NAMESPACE}`);

const shutdown = () => {
  abort.abort();
  clearInterval(timer);
  health.close();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
