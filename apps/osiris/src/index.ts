import { serve } from "@hono/node-server";
import { SecretBox } from "@osiris/core/secrets.ts";
import { InternalVerifier } from "@osiris/platform/internal-auth.ts";
import { runtimeToken } from "@osiris/platform/runtime-identity.ts";
import { Activity } from "./activity.ts";
import { createRuntimeApp } from "./app.ts";
import { loadConfig, serverConfig } from "./config.ts";
import { buildProject } from "./build.ts";
import { ControlClient, RemoteFeatures } from "./control.ts";
import { hasProject, projectDir, restoreSnapshot, withSnapshot } from "./snapshot.ts";
import { startTelemetry } from "@osiris/platform/telemetry.ts";
import { monthOf } from "@osiris/core/agent/usage.ts";
import type { ReportedUsage } from "@osiris/shared";

// Server mode: one project in the cluster, behind the gateway (local mode is cli.ts).
const config = serverConfig(loadConfig());
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
const features = new RemoteFeatures(control);
const project = await buildProject(config, config.PROJECT_ID, projectDir(config.DATA_DIR), {
  features,
  secrets: config.PROJECT_SECRETS_KEY ? new SecretBox(config.PROJECT_SECRETS_KEY) : SecretBox.insecureDev(),
  schedules: control,
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
