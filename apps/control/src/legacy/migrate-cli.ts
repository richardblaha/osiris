import { readdirSync } from "node:fs";
import { join } from "node:path";
import { FsObjectStore, S3ObjectStore } from "@osiris/platform/objects.ts";
import { LocalDb, migrate, RqliteDb } from "@osiris/platform/rqlite.ts";
import { deriveTenantKey } from "@osiris/platform/tenant-keys.ts";
import { Backups } from "../backups.ts";
import { loadConfig } from "../config.ts";
import { KubernetesOrchestrator } from "../orchestrator/kubernetes.ts";
import { TenantStore } from "../tenants.ts";
import { importLegacyTenant } from "./import.ts";

// One-off import of the monolith's tenants (run as a Job with the old data volume mounted, the monolith stopped):
//   LEGACY_DATA_DIR=/legacy/tenants LEGACY_FILES_DIR=/legacy/files LEGACY_SECRETS_KEY=… SECRETS_MASTER_KEY=… pnpm migrate-legacy
const config = loadConfig();
const env = (name: string) => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
};
const dataDir = env("LEGACY_DATA_DIR");
const filesDir = process.env.LEGACY_FILES_DIR;
const oldKey = env("LEGACY_SECRETS_KEY");
const master = env("SECRETS_MASTER_KEY");

const db = config.RQLITE_URL ? new RqliteDb(config.RQLITE_URL, { username: config.RQLITE_USERNAME, password: config.RQLITE_PASSWORD }) : new LocalDb(config.LOCAL_DB_PATH);
await migrate(db, join(import.meta.dirname, "../db/migrations"));
const objects = config.S3_BUCKET
  ? new S3ObjectStore({ endpoint: config.S3_ENDPOINT!, region: config.S3_REGION, bucket: config.S3_BUCKET, accessKeyId: config.S3_ACCESS_KEY_ID!, secretAccessKey: config.S3_SECRET_ACCESS_KEY! })
  : new FsObjectStore(config.LOCAL_OBJECTS_DIR);
const backups = new Backups(db, objects, config.BACKUP_RETENTION_DAYS);
const store = new TenantStore(db);
const orchestrator = config.ORCHESTRATOR === "kubernetes" ? new KubernetesOrchestrator({ namespace: config.K8S_NAMESPACE, runtimePort: config.RUNTIME_PORT }) : undefined;

const ids = readdirSync(dataDir)
  .filter((f) => f.endsWith(".db"))
  .map((f) => f.slice(0, -3))
  .filter((id) => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(id));
for (const id of ids) {
  const result = await importLegacyTenant(
    { id, dbFile: join(dataDir, `${id}.db`), filesDir: filesDir ? join(filesDir, id) : undefined },
    { db, backups, oldKey, newKey: deriveTenantKey(master, id) },
  );
  if (orchestrator) await orchestrator.apply(await store.spec(id));
  console.log(`Imported ${id} (${result.name}${result.archived ? ", archived" : ""}, ${result.resealed} secrets re-sealed)`);
}
console.log(`Done: ${ids.length} tenants.`);
await db.close();
