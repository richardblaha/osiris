import { randomUUID } from "node:crypto";
import { HumanMessage } from "@langchain/core/messages";
import type { RunContext } from "../agent/context.ts";
import type { Identity } from "../auth/oidc.ts";
import { accessibleTenants, type Membership } from "../auth/tenants.ts";
import * as threads from "../repo/threads.ts";
import * as sessions from "../repo/whatsapp.ts";
import type { TenantDirectory } from "../tenants/directory.ts";
import type { TenantRegistry } from "../tenants/registry.ts";
import type { Tenant } from "../tenants/tenant.ts";
import type { InboundMessage, WhatsAppClient } from "./cloud-api.ts";
import type { PhoneDirectory } from "./directory.ts";

export interface WhatsAppDeps {
  tenants: TenantRegistry;
  /** Every tenant, for system admins (who can open all of them). */
  directory: TenantDirectory;
  phones: PhoneDirectory;
  client: WhatsAppClient;
}

const NOT_REGISTERED = "Tohle číslo nemá v Osirisu účet. Požádej správce, ať ti ho nastaví v profilu.";
const NO_TENANT = "Nejsi přiřazený k žádnému tenantovi. Obrať se na správce.";
const TEXT_ONLY = "Zatím rozumím jen textovým zprávám.";
const FAILED = "Omlouvám se, něco se pokazilo. Zkus to prosím znovu.";
const NEW_THREAD = "Dobře, začínáme novou konverzaci.";
const HELP = [
  "*Příkazy*",
  "• /tenant – tvoji tenanti a který je aktivní",
  "• /tenant <zkratka> – přepne na jiného tenanta",
  "• /nova – začne novou konverzaci",
].join("\n");

/** How many message IDs are remembered to drop Meta's redeliveries. */
const SEEN_MAX = 2000;

/**
 * WhatsApp as a client of the agent. The user comes from the sender's number (PocketID `phone_number`) and the tenant
 * from their groups; a user in several tenants picks one with `/tenant <slug>`. Each user has one running WhatsApp
 * thread per tenant (it also shows in the web chat), and `/nova` starts a new one.
 */
export class WhatsAppChannel {
  private readonly seen = new Set<string>();
  /** Messages from one number are handled in order, one run at a time. In-process only, like `activeRuns`. */
  private readonly queues = new Map<string, Promise<void>>();

  constructor(private readonly deps: WhatsAppDeps) {}

  /** Queues a message and returns at once: the webhook must answer Meta quickly, the run can take a while. */
  receive(message: InboundMessage): void {
    if (this.seen.has(message.id)) return;
    this.seen.add(message.id);
    if (this.seen.size > SEEN_MAX) this.seen.delete(this.seen.values().next().value!);

    const next = (this.queues.get(message.from) ?? Promise.resolve())
      .then(() => this.handle(message))
      .catch((err) => console.error("WhatsApp reply failed", { messageId: message.id, err }));
    this.queues.set(message.from, next);
    void next.finally(() => {
      if (this.queues.get(message.from) === next) this.queues.delete(message.from);
    });
  }

  /** Resolves once every queued message is handled (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.queues.size) await Promise.all(this.queues.values());
  }

  private async handle(message: InboundMessage): Promise<void> {
    const reply = (text: string) => this.deps.client.sendText(message.phoneNumberId, message.from, text);
    try {
      const user = await this.deps.phones.lookup(message.from);
      if (!user) return await reply(NOT_REGISTERED);
      const memberships = await accessibleTenants(user.groups, this.deps.directory);
      if (!memberships.length) return await reply(NO_TENANT);
      if (message.type === "reaction") return;
      const text = message.text?.trim();
      if (message.type !== "text" || !text) return await reply(TEXT_ONLY);

      const command = /^\/(tenant|nova|pomoc)\b\s*(.*)$/isu.exec(text);
      if (command?.[1]!.toLowerCase() === "tenant") return await reply(await this.switchTenant(user, memberships, command[2]!.trim()));
      if (command?.[1]!.toLowerCase() === "pomoc") return await reply(HELP);

      const active = await this.activeTenant(user, memberships);
      if (!active) return await reply(`${this.tenantList(memberships)}\nNapiš /tenant <zkratka> a vyber, se kterým chceš pracovat.`);
      if (!(await active.tenant.features.enabled("whatsapp"))) {
        return await reply(`WhatsApp není pro tenanta *${active.tenant.id}* povolený.`);
      }
      if (command) {
        await sessions.setThread(active.tenant.db, user.sub, null);
        return await reply(NEW_THREAD);
      }

      // Best effort: a failed read receipt must not stop the reply.
      await this.deps.client.markRead(message.phoneNumberId, message.id).catch(() => {});
      const answer = await this.run(user, active, text);
      if (answer) await reply(answer);
    } catch (err) {
      console.error("WhatsApp message failed", { messageId: message.id, err });
      await reply(FAILED);
    }
  }

  private async run(user: Identity, { tenant, role }: Active, text: string): Promise<string> {
    const threadId = await this.thread(tenant, user.sub);
    await threads.touchThread(tenant.db, threadId, text);
    const ctx: RunContext = {
      thread_id: threadId,
      tenant_id: tenant.id,
      user_id: user.sub,
      role,
      channel: "whatsapp",
      user_name: user.name ?? undefined,
    };
    const { messages } = await tenant.graph.invoke({ messages: [new HumanMessage(text)] }, { configurable: { ...ctx } });
    return messages.at(-1)?.text ?? "";
  }

  /** The user's current WhatsApp thread in this tenant, created if there is none (or it was deleted on the web). */
  private async thread(tenant: Tenant, userId: string): Promise<string> {
    const session = await sessions.getSession(tenant.db, userId);
    if (session?.threadId && (await threads.ownsThread(tenant.db, userId, session.threadId))) return session.threadId;
    const id = randomUUID();
    await threads.createThread(tenant.db, userId, id, "whatsapp");
    await sessions.setThread(tenant.db, userId, id);
    return id;
  }

  /** The only tenant, or the one picked most recently with `/tenant`; null if the user has several and picked none. */
  private async activeTenant(user: Identity, memberships: Membership[]): Promise<Active | null> {
    if (memberships.length === 1) {
      const [m] = memberships;
      return { tenant: await this.deps.tenants.get(m!.tenantId), role: m!.role };
    }
    let best: (Active & { at: number }) | null = null;
    for (const m of memberships) {
      const tenant = await this.deps.tenants.get(m.tenantId);
      const at = (await sessions.getSession(tenant.db, user.sub))?.selectedAt;
      if (at != null && (!best || at > best.at)) best = { tenant, role: m.role, at };
    }
    return best;
  }

  private async switchTenant(user: Identity, memberships: Membership[], slug: string): Promise<string> {
    if (!slug) {
      const active = await this.activeTenant(user, memberships);
      const current = active ? `Aktivní tenant: *${active.tenant.id}*.` : "Zatím nemáš vybraného tenanta.";
      return `${current}\n${this.tenantList(memberships)}${memberships.length > 1 ? "\nPřepneš příkazem /tenant <zkratka>." : ""}`;
    }
    const membership = memberships.find((m) => m.tenantId === slug.toLowerCase());
    if (!membership) return `Tenanta „${slug}“ nemáš.\n${this.tenantList(memberships)}`;
    const tenant = await this.deps.tenants.get(membership.tenantId);
    await sessions.selectTenant(tenant.db, user.sub, Date.now());
    return `Přepnuto na tenanta *${tenant.id}*.`;
  }

  private tenantList(memberships: Membership[]): string {
    return `Tvoji tenanti: ${memberships.map((m) => m.tenantId).join(", ")}.`;
  }
}

interface Active {
  tenant: Tenant;
  role: Membership["role"];
}
