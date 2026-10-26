import { accessFromClaims, groupsFromAccess } from "@osiris/platform/claims.ts";
import { run, type Db, type Statement, type Value } from "@osiris/platform/rqlite.ts";

/**
 * Brings control's users over once (before osiris-auth existed, control was the identity provider): every user with
 * the same id, password, authenticator, recovery codes, passkeys and linked accounts; their claims become groups and
 * `phone_number` the phone. Sessions, tokens and one-time links stay behind, so everyone signs in again. TOTP secrets
 * stay sealed, so osiris-auth needs control's AUTH_SECRET. Users already here are skipped, so it can run again.
 */
export async function importFromControl(source: Db, target: Db): Promise<{ imported: string[]; skipped: string[] }> {
  type Row = Record<string, Value>;
  const existing = new Set((await target.query<{ id: string }>("SELECT id FROM users")).map((r) => r.id));
  const sourceUsers = await source.query<Row & { id: string; claims: string }>(
    "SELECT id, email, email_verified, first_name, last_name, claims, disabled, picture, password_hash, totp_secret, totp_pending, totp_step, last_login_at, created_at, updated_at FROM users",
  );
  const related = async (table: string, columns: string) => {
    const rows = await source.query<Row & { user_id: string }>(`SELECT ${columns} FROM ${table}`);
    return (userId: string): Statement[] => {
      const names = columns.split(", ");
      return rows.filter((r) => r.user_id === userId).map((r) => run(`INSERT INTO ${table} (${columns}) VALUES (${names.map(() => "?").join(", ")}) ON CONFLICT DO NOTHING`, ...names.map((n) => r[n] ?? null)));
    };
  };
  const recovery = await related("recovery_codes", "user_id, code_hash");
  const passkeys = await related("passkeys", "id, user_id, public_key, counter, transports, name, created_at, last_used_at");
  const identities = await related("user_identities", "provider, subject, user_id, email, created_at");

  const imported: string[] = [];
  const skipped: string[] = [];
  for (const u of sourceUsers) {
    if (existing.has(u.id)) {
      skipped.push(u.id);
      continue;
    }
    const claims = JSON.parse(u.claims || "{}") as Record<string, unknown>;
    const phone = typeof claims.phone_number === "string" ? claims.phone_number : null;
    const now = Date.now();
    await target.execute([
      run(
        `INSERT INTO users (id, email, email_verified, first_name, last_name, phone, disabled, password_hash, totp_secret, totp_pending, totp_step, last_login_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ...[u.id, u.email, u.email_verified, u.first_name, u.last_name, phone, u.disabled, u.password_hash, u.totp_secret, u.totp_pending, u.totp_step ?? 0, u.last_login_at, u.created_at ?? now, u.updated_at ?? now].map((v) => v ?? null),
      ),
      ...groupsFromAccess(accessFromClaims((k) => claims[k])).flatMap((g) => [
        run("INSERT INTO groups (id, display_name, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING", g, g, now),
        run("INSERT INTO group_members (group_id, user_id) VALUES (?, ?) ON CONFLICT DO NOTHING", g, u.id),
      ]),
      ...recovery(u.id),
      ...passkeys(u.id),
      ...identities(u.id),
    ]);
    imported.push(u.id);
  }
  return { imported, skipped };
}
