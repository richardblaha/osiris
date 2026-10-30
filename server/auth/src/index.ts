import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { FsObjectStore } from "@osiris/platform/objects.ts";
import { LocalDb, migrate } from "@osiris/platform/db.ts";
import { startTelemetry } from "@osiris/platform/telemetry.ts";
import { startLoop } from "@osiris/platform/worker.ts";
import { createAuthApp } from "./app.ts";
import { createAuth } from "./auth.ts";
import { osirisClients } from "./clients.ts";
import { loadConfig } from "./config.ts";
import { authListener } from "./server.ts";
import { Users } from "./users.ts";

startTelemetry("osiris-auth");
const config = loadConfig();

// One replica with its own SQLite file: sign-in is light, and the file is on the service's volume.
mkdirSync(config.DATA_DIR, { recursive: true });
const db = new LocalDb(join(config.DATA_DIR, "auth.db"));
const applied = await migrate(db, join(import.meta.dirname, "db/migrations"));
if (applied.length) console.log(`Applied migrations ${applied.join(", ")}`);

const users = new Users(db, { objects: new FsObjectStore(join(config.DATA_DIR, "objects")), publicUrl: config.PUBLIC_URL });
const auth = await createAuth(config, db, users);
const app = createAuthApp(auth, { staticDir: config.STATIC_DIR, logo: config.APP_LOGO_URL });

// Osiris's apps, when its origins are configured and they aren't registered yet.
const added = await auth.clients.ensure(osirisClients(config.WEB_ORIGINS, config.GATEWAY_CLIENT_SECRET));
if (added.length) console.log(`Registered ${added.join(", ")}`);

const cleanup = startLoop("Cleanup", 6 * 60 * 60_000, async () => {
  await auth.credentials.cleanup();
  await auth.activity.cleanup();
  return false;
});

const server = createServer(authListener(app, auth.provider, { trusted: config.TRUSTED_PROXIES, cdn: config.CDN_PROXIES })).listen(config.PORT, () => console.log(`osiris-auth listening on http://localhost:${config.PORT} (issuer ${config.PUBLIC_URL})`));
const shutdown = async () => {
  server.close();
  await cleanup.stop();
  await db.close();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
