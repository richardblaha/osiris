import { userDir, type Records } from "../projects/records.ts";
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
  constructor(private records: Records, private box: SecretBox) {}
  private dir = (owner: string) => `${userDir(owner)}/accounts`;
  async list(owner: string) {
    return (await this.records.all<{ kind: string }>(this.dir(owner))).map(r => ({ name: r.name, kind: r.value.kind }));
  }
  async get(owner: string, name: string): Promise<StandardAccount> {
    const r = await this.records.read<{ dataEnc: string }>(`${this.dir(owner)}/${name}.json`).catch(() => undefined);
    if (!r) throw new LocalizedError("errors.integration.accountMissing");
    return standardAccountSchema.parse(JSON.parse(this.box.open(r.dataEnc)));
  }
  async put(owner: string, name: string, account: StandardAccount) {
    account = standardAccountSchema.parse(account);
    await this.records.write(`${this.dir(owner)}/${name}.json`, { kind: account.kind, dataEnc: this.box.seal(JSON.stringify(account)) });
  }
  async delete(owner: string, name: string) {
    await this.records.remove(`${this.dir(owner)}/${name}.json`);
  }
}
