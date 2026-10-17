import type { Role } from "@osiris/shared";
import { accessibleTenants, isAuthorized, type Membership } from "@osiris/platform/claims.ts";
import { isUnreachable, ServiceError } from "@osiris/platform/http.ts";
import { tenantAudience, type InternalSigner, type InternalUser } from "@osiris/platform/internal-auth.ts";
import { run, type Db } from "@osiris/platform/rqlite.ts";
import type { RuntimeClient } from "@osiris/platform/runtime-client.ts";
import type { TenantStore } from "../tenants.ts";
import type { UserDirectory } from "../users.ts";
import type { WhatsAppClient } from "./cloud-api.ts";
import type { Inbox, InboxMessage } from "./inbox.ts";
import { userByPhone, VERIFY_MESSAGE, type PhoneVerification } from "./phones.ts";

const NOT_REGISTERED = "Tohle číslo nemá v Osirisu účet. Ověř si ho v profilu (Můj profil → Telefon), nebo požádej správce.";
const NO_TENANT = "Nejsi přiřazený k žádnému tenantovi. Obrať se na správce.";
const TEXT_ONLY = "Zatím rozumím jen textovým zprávám.";
const FAILED = "Omlouvám se, něco se pokazilo. Zkus to prosím znovu.";
const NEW_THREAD = "Dobře, začínáme novou konverzaci.";
const VERIFIED = "Číslo je ověřené. Teď mi můžeš psát.";
const BAD_CODE = "Kód nesedí nebo vypršel. Vyžádej si v profilu nový.";
const HELP = [
  "*Příkazy*",
  "• /tenant – tvoji tenanti a který je aktivní",
  "• /tenant <zkratka> – přepne na jiného tenanta",
  "• /nova – začne novou konverzaci",
].join("\n");

const MAX_ATTEMPTS = 3;
/** An agent run can take a while (tools, external APIs). */
const RUN_TIMEOUT_MS = 5 * 60_000;

/**
 * Handles queued WhatsApp messages: finds the user by number (PocketID claim `phone_number`), the tenant from their
 * claims and their `/tenant` choice, and passes the text to that tenant's runtime, which runs the agent in the user's
 * WhatsApp thread and returns the reply. Runtimes have no WhatsApp token; only control sends.
 */
export class WhatsAppRouter {
  constructor(
    private readonly deps: {
      db: Db;
      inbox: Inbox;
      users: UserDirectory;
      tenants: TenantStore;
      phones: PhoneVerification;
      client: WhatsAppClient;
      runtimes: RuntimeClient;
      signer: InternalSigner;
    },
  ) {}

  /** Handles the next queued message; false when there was none. */
  async step(): Promise<boolean> {
    const message = await this.deps.inbox.claim();
    if (!message) return false;
    try {
      await this.handle(message);
      await this.deps.inbox.finish(message.id, "done");
    } catch (err) {
      const retryable = isUnreachable(err) || (err instanceof ServiceError && err.status >= 500);
      if (retryable && message.attempts < MAX_ATTEMPTS) {
        await this.deps.inbox.retry(message.id, 30_000 * message.attempts, String(err));
      } else {
        console.error("WhatsApp message failed", { messageId: message.id, err });
        await this.deps.inbox.finish(message.id, "failed", String(err));
        await this.reply(message, FAILED).catch(() => {});
      }
    }
    return true;
  }

  private reply(message: InboxMessage, text: string) {
    return this.deps.client.sendText(message.phoneNumberId, message.from, text);
  }

  private async handle(message: InboxMessage): Promise<void> {
    if (message.type === "reaction") return;
    const text = message.text?.trim();

    const code = text && VERIFY_MESSAGE.exec(text)?.[1];
    if (code) return this.reply(message, (await this.deps.phones.confirm(message.from, code)) ? VERIFIED : BAD_CODE);

    const user = await userByPhone(this.deps.users, message.from);
    if (!user || !isAuthorized(user.access)) return this.reply(message, NOT_REGISTERED);
    const active = (await this.deps.tenants.list()).map((t) => t.id);
    const memberships = accessibleTenants(user.access, active).filter((m) => active.includes(m.tenantId));
    if (!memberships.length) return this.reply(message, NO_TENANT);
    if (message.type !== "text" || !text) return this.reply(message, TEXT_ONLY);

    const command = /^\/(tenant|nova|pomoc)\b\s*(.*)$/isu.exec(text);
    const name = command?.[1]!.toLowerCase();
    if (name === "tenant") return this.reply(message, await this.switchTenant(user, memberships, command![2]!.trim()));
    if (name === "pomoc") return this.reply(message, HELP);

    const selected = await this.activeTenant(user.sub, memberships);
    if (!selected) return this.reply(message, `${tenantList(memberships)}\nNapiš /tenant <zkratka> a vyber, se kterým chceš pracovat.`);
    const tenant = await this.deps.tenants.get(selected.tenantId);
    if (!tenant?.features.whatsapp) return this.reply(message, `WhatsApp není pro tenanta *${selected.tenantId}* povolený.`);

    const headers = await this.headers(user, selected);
    if (name === "nova") {
      await this.call(selected.tenantId, "/internal/whatsapp/new-thread", headers, {});
      return this.reply(message, NEW_THREAD);
    }
    // Best effort: a failed read receipt must not stop the reply.
    await this.deps.client.markRead(message.phoneNumberId, message.id).catch(() => {});
    const { reply } = await this.call<{ reply: string }>(selected.tenantId, "/internal/whatsapp/message", headers, { messageId: message.id, text });
    if (reply) await this.reply(message, reply);
  }

  private async headers(user: InternalUser, m: Membership) {
    const { access: _, ...plain } = user as InternalUser & { access?: unknown };
    return {
      authorization: await this.deps.signer.header(tenantAudience(m.tenantId), { user: plain, tenant: m.tenantId, role: m.role, channel: "whatsapp" }, 600),
      "content-type": "application/json",
    };
  }

  private async call<T = unknown>(tenant: string, path: string, headers: Record<string, string>, body: unknown): Promise<T> {
    const res = await this.deps.runtimes.request(tenant, path, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(RUN_TIMEOUT_MS),
    });
    if (!res.ok) throw new ServiceError(`Runtime ${tenant} ${path}: ${res.status} ${await res.text()}`, res.status);
    return (res.status === 204 ? {} : await res.json()) as T;
  }

  /** The only tenant, or the one picked with `/tenant` (if the user is still in it); null otherwise. */
  private async activeTenant(userId: string, memberships: Membership[]): Promise<{ tenantId: string; role: Role } | null> {
    if (memberships.length === 1) return memberships[0]!;
    const [row] = await this.deps.db.query<{ tenant_id: string }>("SELECT tenant_id FROM wa_selection WHERE user_id = ?", [userId]);
    return memberships.find((m) => m.tenantId === row?.tenant_id) ?? null;
  }

  private async switchTenant(user: InternalUser, memberships: Membership[], slug: string): Promise<string> {
    if (!slug) {
      const active = await this.activeTenant(user.sub, memberships);
      const current = active ? `Aktivní tenant: *${active.tenantId}*.` : "Zatím nemáš vybraného tenanta.";
      return `${current}\n${tenantList(memberships)}${memberships.length > 1 ? "\nPřepneš příkazem /tenant <zkratka>." : ""}`;
    }
    const membership = memberships.find((m) => m.tenantId === slug.toLowerCase());
    if (!membership) return `Tenanta „${slug}“ nemáš.\n${tenantList(memberships)}`;
    await this.deps.db.execute([
      run(
        `INSERT INTO wa_selection (user_id, tenant_id, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (user_id) DO UPDATE SET tenant_id = excluded.tenant_id, updated_at = excluded.updated_at`,
        user.sub,
        membership.tenantId,
        Date.now(),
      ),
    ]);
    return `Přepnuto na tenanta *${membership.tenantId}*.`;
  }
}

const tenantList = (memberships: Membership[]) => `Tvoji tenanti: ${memberships.map((m) => m.tenantId).join(", ")}.`;
