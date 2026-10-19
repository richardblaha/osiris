import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { serve } from "@hono/node-server";
import { createChatModel } from "@osiris/core/agent/model.ts";
import { loadSkills } from "@osiris/core/agent/skills.ts";
import { createDb } from "@osiris/core/db/client.ts";
import { migrate } from "@osiris/core/db/migrate.ts";
import { createEmbeddings } from "@osiris/core/rag/embeddings.ts";
import { SecretBox } from "@osiris/core/secrets.ts";
import { openTenant } from "@osiris/core/tenants/tenant.ts";
import { InternalVerifier } from "@osiris/platform/internal-auth.ts";
import { runtimeToken } from "@osiris/platform/runtime-identity.ts";
import { Activity } from "./activity.ts";
import { createRuntimeApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { ControlClient, RemoteFeatures } from "./control.ts";
import { dbPath, filesDir, hasDatabase, restoreSnapshot, withSnapshot } from "./snapshot.ts";
import { controlTools, publishFolder } from "./tools.ts";
import { startTelemetry } from "@osiris/platform/telemetry.ts";

const config = loadConfig();
startTelemetry("osiris-runtime", { "osiris.tenant": config.TENANT_ID });
const control = new ControlClient(
  config.CONTROL_URL,
  runtimeToken(config.DEV_RUNTIME_AUTH ? { devTenant: config.TENANT_ID } : { tokenPath: config.RUNTIME_TOKEN_PATH }),
);

// A runtime starting on an empty volume (new pod, lost volume, data imported from the monolith) restores the newest snapshot.
if (!hasDatabase(config.DATA_DIR)) {
  const backup = await control.latestBackup();
  if (backup) {
    console.log(`Restoring ${config.TENANT_ID} from ${backup.key}`);
    await restoreSnapshot(config.DATA_DIR, backup.body);
  }
}
mkdirSync(dirname(dbPath(config.DATA_DIR)), { recursive: true });
const db = createDb(`file:${dbPath(config.DATA_DIR)}`);
const applied = await migrate(db);
if (applied.length) console.log(`Tenant ${config.TENANT_ID}: applied migrations ${applied.join(", ")}`);

if (!config.TENANT_SECRETS_KEY) console.warn("TENANT_SECRETS_KEY not set: secrets use an insecure development key.");
const files = { dir: filesDir(config.DATA_DIR), maxFileBytes: config.FILES_MAX_FILE_MB * 1024 * 1024, quotaBytes: config.FILES_QUOTA_MB * 1024 * 1024 };
const bundledSkills = loadSkills(config.SKILLS_DIR);

const features = new RemoteFeatures(control);
const tenant = openTenant(config.TENANT_ID, db, {
  model: await createChatModel(config.LLM_MODEL),
  embeddings: createEmbeddings(config.EMBEDDING_MODEL),
  embeddingModel: config.EMBEDDING_MODEL,
  bundledSkills,
  timezone: config.TIMEZONE,
  secrets: config.TENANT_SECRETS_KEY ? new SecretBox(config.TENANT_SECRETS_KEY) : SecretBox.insecureDev(),
  mcp: { allowPrivate: config.MCP_ALLOW_PRIVATE },
  files,
  gotenbergUrl: config.GOTENBERG_URL,
  features,
  extraTools: (store) => controlTools(control, store, config.TIMEZONE),
});

const activity = new Activity();
const snapshot = (reason: string) => withSnapshot(db, config.DATA_DIR, (archive) => control.uploadBackup(archive, reason));

const app = createRuntimeApp({
  tenant,
  verifier: new InternalVerifier(config.INTERNAL_JWT_PUBLIC_KEY),
  activity,
  snapshot,
  publishSite: (loc, dir, domain, userId) => publishFolder(control, tenant.files, loc, dir, domain, userId),
  counts: () => features.counts(),
});
const server = serve({ fetch: app.fetch, port: config.PORT }, ({ port }) =>
  console.log(`Runtime of ${config.TENANT_ID} listening on http://localhost:${port}`),
);

// Tenants that never sleep (or rarely) still get a daily snapshot.
const daily = setInterval(() => {
  if (!activity.sleeping) snapshot("daily").catch((err) => console.error("Daily snapshot failed", err));
}, 24 * 60 * 60_000);

const shutdown = async () => {
  clearInterval(daily);
  activity.sleeping = true;
  server.close();
  await tenant.mcp.close();
  db.close();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
