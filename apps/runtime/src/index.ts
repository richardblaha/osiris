import { MediaReader } from "@osiris/core/agent/attachments.ts";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { serve } from "@hono/node-server";
import { createAgentModels } from "@osiris/core/agent/model.ts";
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
import { dataDbPath, dbPath, filesDir, hasDatabase, restoreSnapshot, withSnapshot } from "./snapshot.ts";
import { controlTools } from "./tools.ts";
import { startTelemetry } from "@osiris/platform/telemetry.ts";
import { monthOf } from "@osiris/core/agent/usage.ts";
import type { ReportedUsage } from "@osiris/shared";

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
const models = await createAgentModels({
  agent: config.LLM_AGENT_MODEL ?? config.LLM_MODEL,
  tools: config.LLM_TOOLS_MODEL ?? config.LLM_MODEL,
  guard: config.LLM_GUARD_MODEL ?? config.LLM_MODEL,
  persona: config.LLM_PERSONA_MODEL ?? config.LLM_MODEL,
});
const tenant = openTenant(config.TENANT_ID, db, {
  model: models.agent,
  models,
  media: new MediaReader(config.MISTRAL_API_KEY, config.AUDIO_MODEL, config.OCR_MODEL),
  embeddings: createEmbeddings(config.EMBEDDING_MODEL),
  embeddingModel: config.EMBEDDING_MODEL,
  bundledSkills,
  timezone: config.TIMEZONE,
  secrets: config.TENANT_SECRETS_KEY ? new SecretBox(config.TENANT_SECRETS_KEY) : SecretBox.insecureDev(),
  mcp: { allowPrivate: config.MCP_ALLOW_PRIVATE, oauthRedirectUrl: `${config.PUBLIC_URL}/mcp-callback` },
  integrations: {
    redirectUrl: `${config.PUBLIC_URL}/integration-callback`,
    clients: {
      ...(config.GOOGLE_INTEGRATION_CLIENT_ID && config.GOOGLE_INTEGRATION_CLIENT_SECRET
        ? { google: { clientId: config.GOOGLE_INTEGRATION_CLIENT_ID, clientSecret: config.GOOGLE_INTEGRATION_CLIENT_SECRET } }
        : {}),
      ...(config.MICROSOFT_INTEGRATION_CLIENT_ID && config.MICROSOFT_INTEGRATION_CLIENT_SECRET
        ? { microsoft: { clientId: config.MICROSOFT_INTEGRATION_CLIENT_ID, clientSecret: config.MICROSOFT_INTEGRATION_CLIENT_SECRET } }
        : {}),
    },
  },
  files,
  database: { path: dataDbPath(config.DATA_DIR) },
  gotenbergUrl: config.GOTENBERG_URL,
  vitepressUrl: config.VITEPRESS_URL,
  features,
  extraTools: (store) => controlTools(control, store, config.TIMEZONE),
  notifyAdmins: (subject, text) => control.notifyAdmins(subject, text),
});

const activity = new Activity();
// What the tenant uses goes to control for System > Dashboard, only when it changed (control writes on every report).
let reported = "";
const reportUsage = async () => {
  const usage: ReportedUsage = {
    storage: await tenant.files.usage(),
    tokens: await tenant.usage.tokens(),
    month: monthOf(),
    tables: await tenant.data.tableCount(),
    database: await tenant.data.size(),
  };
  const json = JSON.stringify(usage);
  if (json === reported) return;
  await control.reportUsage(usage);
  reported = json;
};
const report = () => reportUsage().catch((err) => console.error("Usage report failed", err));
const snapshot = async (reason: string) => {
  if (reason === "sleep") await report();
  return withSnapshot(db, config.DATA_DIR, tenant.data.db, (archive) => control.uploadBackup(archive, reason));
};

const app = createRuntimeApp({
  tenant,
  verifier: new InternalVerifier(config.INTERNAL_JWT_PUBLIC_KEY),
  activity,
  snapshot,
  counts: () => features.counts(),
});
// Before serving: old database content moves to files, and the file indexes catch up with the files on disk.
await tenant.init();
const server = serve({ fetch: app.fetch, port: config.PORT }, ({ port }) =>
  console.log(`Runtime of ${config.TENANT_ID} listening on http://localhost:${port}`),
);

const usageTimer = setInterval(() => void (activity.sleeping || report()), 5 * 60_000);
void report();

// Tenants that never sleep (or rarely) still get a daily snapshot.
const daily = setInterval(() => {
  if (!activity.sleeping) snapshot("daily").catch((err) => console.error("Daily snapshot failed", err));
}, 24 * 60 * 60_000);

const shutdown = async () => {
  clearInterval(daily);
  clearInterval(usageTimer);
  activity.sleeping = true;
  server.close();
  await tenant.mcp.close();
  db.close();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
