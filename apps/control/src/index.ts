import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { serve } from "@hono/node-server";
import { InternalSigner, InternalVerifier, tenantAudience } from "@osiris/platform/internal-auth.ts";
import { FsObjectStore, S3ObjectStore, type ObjectStore } from "@osiris/platform/objects.ts";
import { LocalDb, migrate, RqliteDb, type Db } from "@osiris/platform/rqlite.ts";
import { RuntimeClient } from "@osiris/platform/runtime-client.ts";
import { devRuntimeVerifier, tokenReviewVerifier } from "@osiris/platform/runtime-identity.ts";
import { startLoop } from "@osiris/platform/worker.ts";
import { createControlApp } from "./app.ts";
import { Backups } from "./backups.ts";
import { loadConfig } from "./config.ts";
import { KubernetesOrchestrator } from "./orchestrator/kubernetes.ts";
import { LocalOrchestrator } from "./orchestrator/local.ts";
import type { Orchestrator } from "./orchestrator/types.ts";
import { PocketIdClient } from "./pocketid.ts";
import { ScheduleStore, SchedulerWorker } from "./scheduler.ts";
import { DomainStore, publicDns } from "./sites/domains.ts";
import { SitePublisher } from "./sites/publisher.ts";
import { TenantDirectory, TenantStore } from "./tenants.ts";
import { memoryUsers, pocketIdUsers } from "./users.ts";
import { WhatsAppClient } from "./whatsapp/cloud-api.ts";
import { Inbox } from "./whatsapp/inbox.ts";
import { PhoneVerification } from "./whatsapp/phones.ts";
import { WhatsAppRouter } from "./whatsapp/router.ts";

const config = loadConfig();

let db: Db;
if (config.RQLITE_URL) {
  db = new RqliteDb(config.RQLITE_URL, { username: config.RQLITE_USERNAME, password: config.RQLITE_PASSWORD });
} else {
  console.warn("RQLITE_URL not set: using a local SQLite file (development only).");
  mkdirSync(dirname(config.LOCAL_DB_PATH), { recursive: true });
  db = new LocalDb(config.LOCAL_DB_PATH);
}
const applied = await migrate(db, join(import.meta.dirname, "db/migrations"));
if (applied.length) console.log(`Applied migrations ${applied.join(", ")}`);

const objects: ObjectStore = config.S3_BUCKET
  ? new S3ObjectStore({
      endpoint: config.S3_ENDPOINT!,
      region: config.S3_REGION,
      bucket: config.S3_BUCKET,
      accessKeyId: config.S3_ACCESS_KEY_ID!,
      secretAccessKey: config.S3_SECRET_ACCESS_KEY!,
    })
  : new FsObjectStore(config.LOCAL_OBJECTS_DIR);

const signer = new InternalSigner(config.INTERNAL_JWT_PRIVATE_KEY, "control");
const verifier = new InternalVerifier(config.INTERNAL_JWT_PUBLIC_KEY, ["gateway"]);

const orchestrator: Orchestrator =
  config.ORCHESTRATOR === "kubernetes"
    ? new KubernetesOrchestrator({ namespace: config.K8S_NAMESPACE, runtimePort: config.RUNTIME_PORT })
    : new LocalOrchestrator({
        entry: config.LOCAL_RUNTIME_ENTRY,
        dataDir: config.LOCAL_RUNTIME_DATA_DIR,
        basePort: config.LOCAL_RUNTIME_BASE_PORT,
        env: { CONTROL_URL: config.PUBLIC_CONTROL_URL, INTERNAL_JWT_PUBLIC_KEY: config.INTERNAL_JWT_PUBLIC_KEY, DEV_RUNTIME_AUTH: "true" },
      });
const runtimes = new RuntimeClient({ endpoint: async (t) => orchestrator.endpoint(t), wake: (t) => orchestrator.wake(t) });

const pocketId = config.POCKETID_API_KEY ? new PocketIdClient(config.OIDC_ISSUER!, config.POCKETID_API_KEY) : undefined;
if (!pocketId) console.warn("POCKETID_API_KEY not set: users are kept in memory (development only).");
const users = pocketId ? pocketIdUsers(pocketId, config.OIDC_ISSUER!) : memoryUsers();

const store = new TenantStore(db);
const directory = new TenantDirectory(store, users, orchestrator);
const schedules = new ScheduleStore(db, config.TIMEZONE);
const domains = new DomainStore(db, publicDns(), {
  ingressIps: config.SITES_INGRESS_IPS,
  cnameTarget: config.SITES_CNAME_TARGET,
  maxPerTenant: config.MAX_DOMAINS_PER_TENANT,
  reserved: ["k6labs.cz", "localhost"],
});
const sites = new SitePublisher(db, objects);
const backups = new Backups(db, objects, config.BACKUP_RETENTION_DAYS);
const phones = new PhoneVerification(db, users);
const inbox = new Inbox(db);
const whatsappClient = config.WHATSAPP_ACCESS_TOKEN ? new WhatsAppClient(config.WHATSAPP_ACCESS_TOKEN) : undefined;
if (!whatsappClient) console.log("WhatsApp is not configured: /webhooks/whatsapp answers 404.");

/** Asks a runtime to snapshot itself now; it streams the snapshot back to /internal/runtime/backups. */
const snapshot = async (tenant: string) => {
  const res = await runtimes.request(tenant, "/internal/snapshot?reason=manual", {
    method: "POST",
    headers: { authorization: await signer.header(tenantAudience(tenant)) },
    signal: AbortSignal.timeout(10 * 60_000),
  });
  if (!res.ok) throw new Error(`Snapshot of ${tenant} failed: ${res.status} ${await res.text()}`);
};

const app = createControlApp({
  verifier,
  runtimeIdentity: config.DEV_RUNTIME_AUTH || config.ORCHESTRATOR === "local" ? devRuntimeVerifier() : tokenReviewVerifier(),
  directory,
  users,
  orchestrator,
  schedules,
  domains,
  sites,
  backups,
  phones,
  snapshot,
  whatsapp: whatsappClient
    ? { inbox, verifyToken: config.WHATSAPP_VERIFY_TOKEN!, appSecret: config.WHATSAPP_APP_SECRET!, displayNumber: config.WHATSAPP_DISPLAY_NUMBER }
    : undefined,
});

// Background work runs on every replica; claims in the database keep them from doing the same item twice.
const loops = [
  startLoop("Scheduler", 5_000, (() => {
    const worker = new SchedulerWorker({ schedules, tenants: store, users, runtimes, signer, whatsapp: whatsappClient && { client: whatsappClient, inbox } });
    return () => worker.step();
  })()),
  ...(whatsappClient
    ? [startLoop("WhatsApp inbox", 1_000, (() => {
        const router = new WhatsAppRouter({ db, inbox, users, tenants: store, phones, client: whatsappClient, runtimes, signer });
        return () => router.step();
      })())]
    : []),
  startLoop("Domain re-check", 10 * 60_000, async () => {
    for (const tenant of await domains.recheck()) await directory.sync(tenant);
    return false;
  }),
  startLoop("Cleanup", 6 * 60 * 60_000, async () => {
    await backups.prune();
    await inbox.cleanup();
    return false;
  }),
];

// Tenants created before the operator existed (or whose resource was lost) get their resource back.
for (const t of await store.list({ archived: true })) await directory.sync(t.id).catch((err) => console.error(`Sync of ${t.id} failed`, err));

const server = serve({ fetch: app.fetch, port: config.PORT }, ({ port }) => console.log(`Control listening on http://localhost:${port}`));
const shutdown = async () => {
  server.close();
  await Promise.all(loops.map((l) => l.stop()));
  await orchestrator.close?.();
  await db.close();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
