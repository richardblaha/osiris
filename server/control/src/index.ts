import { mkdirSync } from "node:fs";
import { DashboardStore } from "./dashboards.ts";
import { dirname, join } from "node:path";
import { createServer } from "node:http";
import { InternalSigner, InternalVerifier, projectAudience } from "@osiris/platform/internal-auth.ts";
import { FsObjectStore, S3ObjectStore, type ObjectStore } from "@osiris/platform/objects.ts";
import { LocalDb, migrate, RqliteDb, type Db } from "@osiris/platform/rqlite.ts";
import { ClickHouse, Telemetry } from "./telemetry/clickhouse.ts";
import { RuntimeClient } from "@osiris/platform/runtime-client.ts";
import { devRuntimeVerifier, tokenReviewVerifier } from "@osiris/platform/runtime-identity.ts";
import { startLoop } from "@osiris/platform/worker.ts";
import { createControlApp } from "./app.ts";
import { createAuth } from "./auth/index.ts";
import { Backups } from "./backups.ts";
import { loadConfig } from "./config.ts";
import { KubernetesOrchestrator } from "./orchestrator/kubernetes.ts";
import { LocalOrchestrator } from "./orchestrator/local.ts";
import type { Orchestrator } from "./orchestrator/types.ts";
import { ScheduleStore, SchedulerWorker } from "./scheduler.ts";
import { controlListener } from "./server.ts";
import { ProjectDirectory, ProjectStore } from "./projects.ts";
import { dbUsers } from "./users.ts";
import { WhatsAppClient } from "./whatsapp/cloud-api.ts";
import { Inbox } from "./whatsapp/inbox.ts";
import { PhoneVerification } from "./whatsapp/phones.ts";
import { WhatsAppRouter } from "./whatsapp/router.ts";
import { startTelemetry } from "@osiris/platform/telemetry.ts";

startTelemetry("osiris-control");
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

const users = dbUsers(db, { objects, publicUrl: config.PUBLIC_URL });
const auth = await createAuth(config, db, users);

const store = new ProjectStore(db, { objects, publicUrl: config.PUBLIC_URL });
await store.migrateSystemGuards();
const directory = new ProjectDirectory(store, users, orchestrator);
const schedules = new ScheduleStore(db, config.TIMEZONE);
const backups = new Backups(db, objects, config.BACKUP_RETENTION_DAYS);
const phones = new PhoneVerification(db, users);
const inbox = new Inbox(db);
const whatsappClient = config.WHATSAPP_ACCESS_TOKEN ? new WhatsAppClient(config.WHATSAPP_ACCESS_TOKEN, fetch, {
  flows: config.WHATSAPP_FLOWS_JSON,
  onSent: (id, phone, to) => inbox.sent(id, phone, to),
  notificationTemplate: config.WHATSAPP_NOTIFICATION_TEMPLATE ? { name: config.WHATSAPP_NOTIFICATION_TEMPLATE, language: config.WHATSAPP_TEMPLATE_LANGUAGE } : undefined,
}) : undefined;
if (!whatsappClient) console.log("WhatsApp is not configured: /webhooks/whatsapp answers 404.");

/** Asks a runtime to snapshot itself now; it streams the snapshot back to /internal/runtime/backups. */
const snapshot = async (project: string) => {
  const res = await runtimes.request(project, "/internal/snapshot?reason=manual", {
    method: "POST",
    headers: { authorization: await signer.header(projectAudience(project)) },
    signal: AbortSignal.timeout(10 * 60_000),
  });
  if (!res.ok) throw new Error(`Snapshot of ${project} failed: ${res.status} ${await res.text()}`);
};

const app = createControlApp({
  verifier,
  runtimeIdentity: config.DEV_RUNTIME_AUTH || config.ORCHESTRATOR === "local" ? devRuntimeVerifier() : tokenReviewVerifier(),
  directory,
  users,
  orchestrator,
  schedules,
  backups,
  phones,
  snapshot,
  auth,
  dashboards: new DashboardStore(db),
  telemetry: config.CLICKHOUSE_URL ? new Telemetry(new ClickHouse(config.CLICKHOUSE_URL, config.CLICKHOUSE_USER, config.CLICKHOUSE_PASSWORD ?? "")) : undefined,
  whatsapp: whatsappClient
    ? { inbox, verifyToken: config.WHATSAPP_VERIFY_TOKEN!, appSecret: config.WHATSAPP_APP_SECRET!, displayNumber: config.WHATSAPP_DISPLAY_NUMBER }
    : undefined,
});

// Background work runs on every replica; claims in the database keep them from doing the same item twice.
const loops = [
  startLoop("Scheduler", 5_000, (() => {
    const worker = new SchedulerWorker({ schedules, projects: store, users, runtimes, signer, whatsapp: whatsappClient && { client: whatsappClient, inbox } });
    return () => worker.step();
  })()),
  ...(whatsappClient
    ? [startLoop("WhatsApp inbox", 1_000, (() => {
        const router = new WhatsAppRouter({ db, inbox, users, projects: store, phones, client: whatsappClient, runtimes, signer, publicUrl: config.PUBLIC_URL });
        return () => router.step();
      })())]
    : []),
  startLoop("Cleanup", 6 * 60 * 60_000, async () => {
    await backups.prune();
    await inbox.cleanup();
    await auth.credentials.cleanup();
    await auth.activity.cleanup();
    return false;
  }),
];

// Projects created before the operator existed (or whose resource was lost) get their resource back.
for (const t of await store.list({ archived: true })) await directory.sync(t.id).catch((err) => console.error(`Sync of ${t.id} failed`, err));

const server = createServer(controlListener(app, auth.provider)).listen(config.PORT, () =>
  console.log(`Control listening on http://localhost:${config.PORT} (sign-in at ${config.PUBLIC_URL}/auth)`),
);
const shutdown = async () => {
  server.close();
  await Promise.all(loops.map((l) => l.stop()));
  await orchestrator.close?.();
  await db.close();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
