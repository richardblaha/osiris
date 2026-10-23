import type { ChatQuestion, Role } from "@osiris/shared";
import { accessibleTenants, isAuthorized, type Membership } from "@osiris/platform/claims.ts";
import { isUnreachable, ServiceError } from "@osiris/platform/http.ts";
import { tenantAudience, type InternalSigner, type InternalUser } from "@osiris/platform/internal-auth.ts";
import { configuredLocale, translate, type Params } from "@osiris/platform/i18n.ts";
import { run, type Db } from "@osiris/platform/rqlite.ts";
import type { RuntimeClient } from "@osiris/platform/runtime-client.ts";
import type { TenantStore } from "../tenants.ts";
import type { UserDirectory } from "../users.ts";
import { WhatsAppApiError, type WhatsAppClient } from "./cloud-api.ts";
import type { Inbox, InboxMessage } from "./inbox.ts";
import { userByPhone, VERIFY_MESSAGE, type PhoneVerification } from "./phones.ts";

/** Replies go out in the configured language: a WhatsApp message carries no language preference. */
const t = (key: string, params?: Params) => translate(configuredLocale(), key, params);

const MAX_ATTEMPTS = 3;
/** An agent run can take a while (tools, external APIs). */
const RUN_TIMEOUT_MS = 5 * 60_000;

/**
 * Handles queued WhatsApp messages: finds the user by number (claim `phone_number`), the tenant from their
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
      publicUrl?: string;
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
      const retryable = isUnreachable(err) || (err instanceof WhatsAppApiError && (err.status >= 500 || err.status === 429)) || (err instanceof ServiceError && (err.status >= 500 || err.status === 409));
      if (retryable && message.attempts < MAX_ATTEMPTS) {
        await this.deps.inbox.retry(message.id, 30_000 * message.attempts, String(err));
      } else {
        console.error("WhatsApp message failed", { messageId: message.id, err });
        await this.deps.inbox.finish(message.id, "failed", String(err));
        await this.reply(message, t("whatsapp.failed")).catch(() => {});
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
    if (code) return this.reply(message, (await this.deps.phones.confirm(message.from, code)) ? t("whatsapp.verified") : t("whatsapp.badCode"));

    const user = await userByPhone(this.deps.users, message.from);
    if (!user || !isAuthorized(user.access)) return this.reply(message, t("whatsapp.notRegistered"));
    const active = (await this.deps.tenants.list()).map((t) => t.id);
    const memberships = accessibleTenants(user.access, active).filter((m) => active.includes(m.tenantId));
    if (!memberships.length) return this.reply(message, t("whatsapp.noTenant"));
    if (!(["text", "interactive", "button"].includes(message.type) && text) && !message.media) return this.reply(message, t("whatsapp.unsupported"));

    // Commands answer to their Czech and English names.
    const command = /^\/(tenant|nova|new|pomoc|help)\b\s*(.*)$/isu.exec(text ?? "");
    const name = ({ new: "nova", help: "pomoc" } as Record<string, string>)[command?.[1]!.toLowerCase() ?? ""] ?? command?.[1]!.toLowerCase();
    if (name === "tenant") return this.reply(message, await this.switchTenant(user, memberships, command![2]!.trim()));
    if (name === "pomoc") return this.reply(message, t("whatsapp.help"));

    const selected = await this.activeTenant(user.sub, memberships);
    if (!selected) return this.reply(message, `${tenantList(memberships)}\n${t("whatsapp.chooseTenant")}`);
    const tenant = await this.deps.tenants.get(selected.tenantId);
    if (!tenant?.features.whatsapp) return this.reply(message, t("whatsapp.featureOff", { tenant: selected.tenantId }));

    const headers = await this.headers(user, selected);
    if (name === "nova") {
      await this.call(selected.tenantId, "/internal/whatsapp/new-thread", headers, {});
      return this.reply(message, t("whatsapp.newThread"));
    }
    // Best effort: a failed read receipt must not stop the reply.
    await this.deps.client.markRead(message.phoneNumberId, message.id).catch(() => {});
    let attachment: { name: string; mime: string; data: string } | undefined;
    if (message.media) {
      const media = await this.deps.client.downloadMedia(message.media.id);
      attachment = { name: message.media.filename ?? `whatsapp-${message.id.replace(/[^a-zA-Z0-9]/g, "").slice(-30)}`, mime: media.mime, data: media.data.toString("base64") };
    }
    try {
      const { reply, question, threadId, files } = await this.call<{ reply: string; question?: ChatQuestion; threadId: string; files?: { scope: string; path: string }[] }>(selected.tenantId, "/internal/whatsapp/message", headers, { messageId: message.id, text: text ?? message.media?.caption ?? t("whatsapp.attachmentOnly"), attachment });
      if (reply) await this.reply(message, reply);
      for (const offer of files ?? []) {
        const file = await this.call<{ data: string; mime: string; name: string }>(selected.tenantId, "/internal/whatsapp/file", headers, { threadId, ...offer });
        await this.deps.client.sendFile(message.phoneNumberId, message.from, { ...file, data: Buffer.from(file.data, "base64") });
      }
      if (question?.state === "open") await this.deps.client.sendQuestion(message.phoneNumberId, message.from, question, `${this.deps.publicUrl ?? "https://osiris.k6labs.cz"}/t/${encodeURIComponent(selected.tenantId)}/chat/${encodeURIComponent(threadId)}`);
    } catch (err) {
      if (err instanceof ServiceError && err.status === 400) return this.reply(message, t("whatsapp.answerInvalid"));
      throw err;
    }
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
      const current = active ? t("whatsapp.activeTenant", { tenant: active.tenantId }) : t("whatsapp.noActiveTenant");
      return `${current}\n${tenantList(memberships)}${memberships.length > 1 ? `\n${t("whatsapp.switchHint")}` : ""}`;
    }
    const membership = memberships.find((m) => m.tenantId === slug.toLowerCase());
    if (!membership) return `${t("whatsapp.unknownTenant", { tenant: slug })}\n${tenantList(memberships)}`;
    await this.deps.db.execute([
      run(
        `INSERT INTO wa_selection (user_id, tenant_id, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (user_id) DO UPDATE SET tenant_id = excluded.tenant_id, updated_at = excluded.updated_at`,
        user.sub,
        membership.tenantId,
        Date.now(),
      ),
    ]);
    return t("whatsapp.switched", { tenant: membership.tenantId });
  }
}

const tenantList = (memberships: Membership[]) => t("whatsapp.tenants", { tenants: new Intl.ListFormat(configuredLocale(), { type: "unit" }).format(memberships.map((m) => m.tenantId)) });
