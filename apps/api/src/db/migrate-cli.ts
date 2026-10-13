import { loadConfig, tenantDbProvider } from "../config.ts";
import { createDb } from "./client.ts";
import { migrate } from "./migrate.ts";

// Tenant databases are migrated automatically when the server opens them; this migrates given tenants ahead of time.
const ids = process.argv.slice(2);
if (!ids.length) {
  console.error("Usage: pnpm --filter @osiris/api migrate <tenant> [<tenant>...]");
  process.exit(1);
}
const provider = tenantDbProvider(loadConfig());
for (const id of ids) {
  const { url, authToken } = await provider.locate(id);
  const applied = await migrate(createDb(url, authToken));
  console.log(`${id}: ${applied.length ? `applied ${applied.join(", ")}` : "up to date"}`);
}
