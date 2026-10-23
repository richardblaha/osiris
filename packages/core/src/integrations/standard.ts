import type { Client } from "@libsql/client";
import { z } from "zod";
import type { SecretBox } from "../secrets.ts";
import { LocalizedError } from "@osiris/platform/i18n.ts";

const endpoint = z.object({
  host: z.string().min(1).max(253).regex(/^[a-zA-Z0-9.:-]+$/),
  port: z.number().int().min(1).max(65535),
  username: z.string().min(1).max(1000).regex(/^[^\r\n]+$/),
  password: z.string().min(1).max(10_000).regex(/^[^\r\n]+$/),
});
export const standardAccountSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("mail"), from: z.email(), smtp: endpoint.extend({ secure: z.boolean().default(true) }).optional(), incoming: endpoint.extend({ protocol: z.enum(["imap", "pop3"]) }).optional() }).refine(v => v.smtp || v.incoming, "errors.validation.mailAccount"),
  z.object({ kind: z.enum(["caldav", "carddav"]), url: z.url().startsWith("https://"), username: z.string().min(1).max(1000), password: z.string().min(1).max(10_000) }),
]);
export type StandardAccount = z.infer<typeof standardAccountSchema>;

/** Credentials never leave the runtime. Connections belong to the signed-in user. */
export class StandardAccounts {
  constructor(private db: Client, private box: SecretBox) {}
  async list(owner: string) {
    const { rows } = await this.db.execute({ sql: "SELECT name, kind FROM standard_accounts WHERE owner = ? ORDER BY name", args: [owner] });
    return rows.map(r => ({ name: String(r.name), kind: String(r.kind) }));
  }
  async get(owner: string, name: string): Promise<StandardAccount> {
    const { rows } = await this.db.execute({ sql: "SELECT data_enc FROM standard_accounts WHERE owner = ? AND name = ?", args: [owner, name] });
    if (!rows[0]) throw new LocalizedError("errors.integration.accountMissing");
    return standardAccountSchema.parse(JSON.parse(this.box.open(String(rows[0].data_enc))));
  }
  async put(owner: string, name: string, account: StandardAccount) {
    account = standardAccountSchema.parse(account);
    await this.db.execute({ sql: "INSERT INTO standard_accounts(owner, name, kind, data_enc) VALUES (?, ?, ?, ?) ON CONFLICT(owner, name) DO UPDATE SET kind=excluded.kind, data_enc=excluded.data_enc", args: [owner, name, account.kind, this.box.seal(JSON.stringify(account))] });
  }
  async delete(owner: string, name: string) {
    await this.db.execute({ sql: "DELETE FROM standard_accounts WHERE owner = ? AND name = ?", args: [owner, name] });
  }
}
