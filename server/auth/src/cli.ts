import { join } from "node:path";
import { FsObjectStore } from "@osiris/platform/objects.ts";
import { LocalDb, migrate, RqliteDb } from "@osiris/platform/rqlite.ts";
import { loadConfig } from "./config.ts";
import { importFromControl } from "./import.ts";
import { createServiceToken } from "./scim.ts";
import { Users } from "./users.ts";

// Administration from the command line (`pnpm --filter @osiris/auth cli <command>`):
//   add-admin <email> [first] [last]   creates (or promotes) a system admin and prints a sign-in link
//   token <name>                       makes (or replaces) a service's SCIM token and prints it once
//   import-control <rqlite-url>        copies control's users once (RQLITE_USERNAME, RQLITE_PASSWORD for the source)
const config = loadConfig();
const [command, ...args] = process.argv.slice(2);

const db = new LocalDb(join(config.DATA_DIR, "auth.db"));
await migrate(db, join(import.meta.dirname, "db/migrations"));
const users = new Users(db, { objects: new FsObjectStore(join(config.DATA_DIR, "objects")), publicUrl: config.PUBLIC_URL });

if (command === "add-admin") {
  const [email, firstName = "", lastName = ""] = args;
  if (!email?.includes("@")) throw new Error("Usage: add-admin <email> [first name] [last name]");
  const user = (await users.findByEmail(email)) ?? (await users.create({ email, firstName, lastName }));
  if (!(await users.group("osiris-admin"))) await users.createGroup("osiris-admin");
  await users.changeMembers("osiris-admin", [user.id], []);
  console.log(`${user.email} is a system admin. Sign-in link (72 h): ${await users.loginLink(user.id, 72, "admin")}`);
} else if (command === "token") {
  const [name] = args;
  if (!name || !/^[a-z0-9-]{1,40}$/.test(name)) throw new Error("Usage: token <name>");
  console.log(await createServiceToken(db, name));
} else if (command === "import-control") {
  const [url] = args;
  if (!url) throw new Error("Usage: import-control <rqlite-url>");
  const source = new RqliteDb(url, { username: process.env.RQLITE_USERNAME, password: process.env.RQLITE_PASSWORD });
  const { imported, skipped } = await importFromControl(source, db);
  console.log(`Imported ${imported.length} users, skipped ${skipped.length} already here.`);
  await source.close();
} else {
  console.error("Commands: add-admin <email> [first name] [last name] | token <name> | import-control <rqlite-url>");
  process.exitCode = 1;
}
await db.close();
