import { join } from "node:path";
import { SYSTEM_ADMIN_ROLE, CLAIMS, claimList } from "@osiris/platform/claims.ts";
import { FsObjectStore, S3ObjectStore } from "@osiris/platform/objects.ts";
import { LocalDb, migrate, RqliteDb } from "@osiris/platform/rqlite.ts";
import { loadConfig } from "../config.ts";
import { PocketIdClient, type PocketIdGroup, type PocketIdUser } from "../pocketid.ts";
import { dbUsers } from "../users.ts";

// User administration from the command line (`pnpm --filter @osiris/control users <command>`):
//   import-pocketid [--links]     copies PocketID's users with their ids and claims (POCKETID_URL, POCKETID_API_KEY);
//                                 --links prints a 72-hour sign-in link for each, as passkeys can't move over
//   add-admin <email> [first] [last]
//                                 creates (or promotes) a system admin and prints a sign-in link
const config = loadConfig();
const [command, ...args] = process.argv.slice(2);

const db = config.RQLITE_URL ? new RqliteDb(config.RQLITE_URL, { username: config.RQLITE_USERNAME, password: config.RQLITE_PASSWORD }) : new LocalDb(config.LOCAL_DB_PATH);
await migrate(db, join(import.meta.dirname, "../db/migrations"));
const objects = config.S3_BUCKET
  ? new S3ObjectStore({ endpoint: config.S3_ENDPOINT!, region: config.S3_REGION, bucket: config.S3_BUCKET, accessKeyId: config.S3_ACCESS_KEY_ID!, secretAccessKey: config.S3_SECRET_ACCESS_KEY! })
  : new FsObjectStore(config.LOCAL_OBJECTS_DIR);
const users = dbUsers(db, { objects, publicUrl: config.PUBLIC_URL });

/** Claims named more than once (the user's own and their groups') become one comma-separated list. */
const mergeClaims = (claims: { key: string; value: string }[]) => {
  const values = new Map<string, string[]>();
  for (const { key, value } of claims) values.set(key, [...(values.get(key) ?? []), ...claimList(value)]);
  return Object.fromEntries([...values].map(([key, list]) => [key, claimList(list).join(",")]));
};

if (command === "import-pocketid") {
  if (!config.POCKETID_URL || !config.POCKETID_API_KEY) throw new Error("POCKETID_URL and POCKETID_API_KEY are required");
  const pocketId = new PocketIdClient(config.POCKETID_URL, config.POCKETID_API_KEY);
  const existing = new Map((await users.list()).map((u) => [u.id, u]));
  // PocketID puts its groups' claims into the token next to the user's own, so access often lives on groups.
  const groupClaims = new Map((await pocketId.all<PocketIdGroup>("api/user-groups")).map((g) => [g.id, g.customClaims ?? []]));
  let imported = 0;
  for (const listed of await pocketId.all<PocketIdUser>("api/users")) {
    const u = await pocketId.get<PocketIdUser>(`api/users/${encodeURIComponent(listed.id)}`);
    const claims = mergeClaims([...(u.customClaims ?? []), ...(u.userGroups ?? []).flatMap((g) => groupClaims.get(g.id) ?? [])]);
    const known = existing.get(u.id);
    if (known) {
      // Running again fills in claims (e.g. from groups) without dropping what was granted in Osiris since.
      const missing = Object.entries(mergeClaims([...Object.entries(known.claims), ...Object.entries(claims)].map(([key, value]) => ({ key, value }))))
        .filter(([key, value]) => known.claims[key] !== value);
      if (missing.length) await users.setClaims(u.id, Object.fromEntries(missing));
      console.log(`${missing.length ? "updated" : "skip"} ${u.id} (${u.email ?? u.username}): already here${missing.length ? `, claims ${JSON.stringify(Object.fromEntries(missing))}` : ""}`);
      continue;
    }
    const [first = "", ...rest] = (u.displayName ?? "").split(" ");
    const user = await users.create({
      // The same id: tenant data (memories, files, schedules) is keyed by it.
      id: u.id,
      email: u.email || null,
      emailVerified: !!u.emailVerified,
      firstName: u.firstName || first || u.username || "",
      lastName: u.lastName || rest.join(" "),
      disabled: !!u.disabled,
      claims,
    });
    imported++;
    const link = args.includes("--links") && !user.disabled ? `  ${await users.loginLink(user.id, 72, "admin")}` : "";
    console.log(`imported ${user.id} ${user.email ?? "(no email)"} ${JSON.stringify(claims)}${link}`);
  }
  console.log(`Done: ${imported} users imported.`);
} else if (command === "add-admin") {
  const [email, firstName = "", lastName = ""] = args;
  if (!email?.includes("@")) throw new Error("Usage: users add-admin <email> [first name] [last name]");
  const user = (await users.findByEmail(email)) ?? (await users.create({ email, firstName, lastName }));
  await users.setClaims(user.id, { [CLAIMS.role]: SYSTEM_ADMIN_ROLE });
  console.log(`${user.email} is a system admin. Sign-in link (72 h): ${await users.loginLink(user.id, 72, "admin")}`);
} else {
  console.error("Commands: import-pocketid [--links] | add-admin <email> [first name] [last name]");
  process.exitCode = 1;
}
await db.close();
