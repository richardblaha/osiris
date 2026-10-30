import { join } from "node:path";
import { FsObjectStore } from "@osiris/platform/objects.ts";
import { LocalDb, migrate } from "@osiris/platform/db.ts";
import { createAuth } from "./auth.ts";
import { loadConfig } from "./config.ts";
import { createServiceToken } from "./scim.ts";
import { Users } from "./users.ts";

// Administration from the command line (`pnpm --filter @osiris/auth cli <command>`):
//   add-admin <email> [first] [last]   creates (or promotes) an admin (ADMIN_GROUP) and prints a sign-in link
//   token <name>                       makes (or replaces) a service's SCIM token and prints it once
//   client list                        the registered apps
//   client add <id> <json>             registers an app ({"name":…,"redirectUris":[…],"confidential":true,…}); prints its secret
//   client remove <id>
const config = loadConfig();
const [command, ...args] = process.argv.slice(2);

const db = new LocalDb(join(config.DATA_DIR, "auth.db"));
await migrate(db, join(import.meta.dirname, "db/migrations"));
const users = new Users(db, { objects: new FsObjectStore(join(config.DATA_DIR, "objects")), publicUrl: config.PUBLIC_URL });

if (command === "add-admin") {
  const [email, firstName = "", lastName = ""] = args;
  if (!email?.includes("@")) throw new Error("Usage: add-admin <email> [first name] [last name]");
  const user = (await users.findByEmail(email)) ?? (await users.create({ email, firstName, lastName }));
  if (!(await users.group(config.ADMIN_GROUP))) await users.createGroup(config.ADMIN_GROUP);
  await users.changeMembers(config.ADMIN_GROUP, [user.id], []);
  console.log(`${user.email} is an admin. Sign-in link (72 h): ${await users.loginLink(user.id, 72, "admin")}`);
} else if (command === "token") {
  const [name] = args;
  if (!name || !/^[a-z0-9-]{1,40}$/.test(name)) throw new Error("Usage: token <name>");
  console.log(await createServiceToken(db, name));
} else if (command === "client") {
  const { clients } = await createAuth(config, db, users);
  const [action, id, raw] = args;
  if (action === "list") for (const c of await clients.list()) console.log(`${c.id}\t${c.name}\t${c.confidential ? "confidential" : "public"}\t${c.redirectUris.join(" ")}`);
  else if (action === "add" && id && raw) {
    const { secret } = await clients.create(id, JSON.parse(raw));
    console.log(secret ? `Registered ${id}. Secret (shown once): ${secret}` : `Registered ${id}.`);
  } else if (action === "remove" && id) console.log((await clients.remove(id)) ? `Removed ${id}.` : `No app ${id}.`);
  else throw new Error("Usage: client list | client add <id> <json> | client remove <id>");
} else {
  console.error("Commands: add-admin <email> [first] [last] | token <name> | client list|add|remove");
  process.exitCode = 1;
}
await db.close();
