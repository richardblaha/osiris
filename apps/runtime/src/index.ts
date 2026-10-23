import { MediaReader } from "@osiris/core/agent/attachments.ts";
import { serve } from "@hono/node-server";
import { createAgentModels } from "@osiris/core/agent/model.ts";
import { loadSkills } from "@osiris/core/agent/skills.ts";
import { createEmbeddings } from "@osiris/core/rag/embeddings.ts";
import { SecretBox } from "@osiris/core/secrets.ts";
import { openProject } from "@osiris/core/projects/project.ts";
import { InternalVerifier } from "@osiris/platform/internal-auth.ts";
import { runtimeToken } from "@osiris/platform/runtime-identity.ts";
import { Activity } from "./activity.ts";
import { createRuntimeApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { ControlClient, RemoteFeatures } from "./control.ts";
import { hasProject, projectDir, restoreSnapshot, withSnapshot } from "./snapshot.ts";
import { controlTools } from "./tools.ts";
import { startTelemetry } from "@osiris/platform/telemetry.ts";
import { monthOf } from "@osiris/core/agent/usage.ts";
import type { ReportedUsage } from "@osiris/shared";

const config = loadConfig();
startTelemetry("osiris-runtime", { "osiris.project": config.PROJECT_ID });
const control = new ControlClient(
  config.CONTROL_URL,
  runtimeToken(config.DEV_RUNTIME_AUTH ? { devProject: config.PROJECT_ID } : { tokenPath: config.RUNTIME_TOKEN_PATH }),
);

// A runtime starting on an empty volume (new pod, lost volume) restores the newest snapshot.
if (!hasProject(config.DATA_DIR)) {
  const backup = await control.latestBackup();
  if (backup) {
    console.log(`Restoring ${config.PROJECT_ID} from ${backup.key}`);
    await restoreSnapshot(config.DATA_DIR, backup.body);
  }
}

if (!config.PROJECT_SECRETS_KEY) console.warn("PROJECT_SECRETS_KEY not set: secrets use an insecure development key.");
const files = { maxFileBytes: config.FILES_MAX_FILE_MB * 1024 * 1024, quotaBytes: config.FILES_QUOTA_MB * 1024 * 1024 };
const bundledSkills = loadSkills(config.SKILLS_DIR);

const features = new RemoteFeatures(control);
const models = await createAgentModels({
  agent: config.LLM_AGENT_MODEL ?? config.LLM_MODEL,
  tools: config.LLM_TOOLS_MODEL ?? config.LLM_MODEL,
  guard: config.LLM_GUARD_MODEL ?? config.LLM_MODEL,
  persona: config.LLM_PERSONA_MODEL ?? config.LLM_MODEL,
});
const project = openProject(config.PROJECT_ID, projectDir(config.DATA_DIR), {
  model: models.agent,
  models,
  media: new MediaReader(config.MISTRAL_API_KEY, config.AUDIO_MODEL, config.OCR_MODEL),
  embeddings: createEmbeddings(config.EMBEDDING_MODEL),
  embeddingModel: config.EMBEDDING_MODEL,
  bundledSkills,
  timezone: config.TIMEZONE,
  secrets: config.PROJECT_SECRETS_KEY ? new SecretBox(config.PROJECT_SECRETS_KEY) : SecretBox.insecureDev(),
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
  comfyApiKey: config.COMFY_API_KEY,
  images: config.IMAGE_GENERATION_ENABLED ? { server: config.IMAGE_MCP_SERVER, maxExecutionTimeMs: config.IMAGE_TIMEOUT_MS, maxAttempts: config.IMAGE_MAX_ATTEMPTS, maxRefinements: config.IMAGE_MAX_REFINEMENTS, maxEstimatedCost: config.IMAGE_MAX_ESTIMATED_COST, maxReadAttempts: config.IMAGE_MAX_READ_ATTEMPTS, maxImages: config.IMAGE_MAX_COUNT, visualEvaluation: config.IMAGE_VISUAL_EVALUATION, apiUploadFallback: config.IMAGE_API_UPLOAD_FALLBACK, uploadApiKeySecret: config.IMAGE_API_KEY_SECRET, retentionDays: config.IMAGE_RETENTION_DAYS, downloadHosts: config.IMAGE_DOWNLOAD_HOSTS } : undefined,
  gotenbergUrl: config.GOTENBERG_URL,
  vitepressUrl: config.VITEPRESS_URL,
  learnMemories: config.MEMORY_LEARN,
  features,
  extraTools: (store) => controlTools(control, store, config.TIMEZONE),
  notifyAdmins: (subject, text) => control.notifyAdmins(subject, text),
});

const activity = new Activity();
// What the project uses goes to control for System > Dashboard, only when it changed (control writes on every report).
let reported = "";
const reportUsage = async () => {
  const usage: ReportedUsage = {
    storage: await project.files.usage(),
    tokens: await project.usage.tokens(),
    month: monthOf(),
    tables: await project.data.tableCount(),
    database: await project.data.size(),
  };
  const json = JSON.stringify(usage);
  if (json === reported) return;
  await control.reportUsage(usage);
  reported = json;
};
const report = () => reportUsage().catch((err) => console.error("Usage report failed", err));
const snapshot = async (reason: string) => {
  if (reason === "sleep") await report();
  return withSnapshot(config.DATA_DIR, project.data.db, (archive) => control.uploadBackup(archive, reason));
};

const app = createRuntimeApp({
  project,
  verifier: new InternalVerifier(config.INTERNAL_JWT_PUBLIC_KEY),
  activity,
  snapshot,
  counts: () => features.counts(),
});
// Before serving: the indexes catch up with the files on disk.
await project.init();
const server = serve({ fetch: app.fetch, port: config.PORT }, ({ port }) =>
  console.log(`Runtime of ${config.PROJECT_ID} listening on http://localhost:${port}`),
);

const usageTimer = setInterval(() => void (activity.sleeping || report()), 5 * 60_000);
void report();

// Projects that never sleep (or rarely) still get a daily snapshot.
const daily = setInterval(() => {
  if (!activity.sleeping) snapshot("daily").catch((err) => console.error("Daily snapshot failed", err));
}, 24 * 60 * 60_000);

const shutdown = async () => {
  clearInterval(daily);
  clearInterval(usageTimer);
  activity.sleeping = true;
  server.close();
  await project.mcp.close();
  project.cache.close();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
