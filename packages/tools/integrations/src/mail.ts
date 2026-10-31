import nodemailer from "nodemailer";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { tool, type StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";
import { getRunContext } from "@osiris/core/agent/context.ts";
import { assertSafePublicUrl } from "@osiris/core/mcp/url.ts";
import type { StandardAccounts } from "@osiris/core/integrations/standard.ts";
import { pop3Read } from "./pop3.ts";
import type { Socket } from "node:net";
import { egressProxy, tunnel } from "@osiris/core/net/egress.ts";

export async function safeMailHost(host: string, allowPrivate = false) {
  await assertSafePublicUrl(`https://${host.includes(":") ? `[${host}]` : host}/`, { allowPrivate });
}

export function mailTools(accounts: StandardAccounts, allowPrivate = false, createTransport = nodemailer.createTransport): StructuredToolInterface[] {
  return [
    tool(async ({ account, to, subject, body }, config) => {
      const a = await accounts.get(getRunContext(config).user_id, account);
      if (a.kind !== "mail" || !a.smtp) throw new Error("Účet nemá SMTP");
      const smtp = a.smtp;
      await safeMailHost(smtp.host, allowPrivate);
      const transport = createTransport({ host: smtp.host, port: smtp.port, secure: smtp.secure,
        requireTLS: !smtp.secure, auth: { user: smtp.username, pass: smtp.password },
        connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000,
        disableFileAccess: true, disableUrlAccess: true,
        // Behind the egress gate: nodemailer gets the gate's tunnel (and then starts TLS over it itself).
        ...(egressProxy() ? { getSocket: (_: unknown, done: (err: Error | null, s?: { connection: Socket }) => void) => void tunnel(smtp.host, smtp.port).then((connection) => done(null, { connection }), done) } : {}) });
      try {
        const result = await transport.sendMail({ from: a.from, to, subject, text: body });
        return JSON.stringify({ messageId: result.messageId, accepted: result.accepted, rejected: result.rejected });
      } finally { transport.close(); }
    }, { name: "mail_send", description: "Odešle e-mail přes propojený SMTP účet. Odesílej jen na žádost uživatele.", schema: z.object({ account: z.string(), to: z.array(z.email()).min(1).max(50), subject: z.string().max(998).regex(/^[^\r\n]*$/), body: z.string().max(1_000_000) }) }),
    tool(async ({ account, mailbox, id, limit }, config) => {
      const a = await accounts.get(getRunContext(config).user_id, account);
      if (a.kind !== "mail" || !a.incoming) throw new Error("Účet nemá příchozí poštu");
      const incoming = a.incoming;
      await safeMailHost(incoming.host, allowPrivate);
      if (incoming.protocol === "pop3") {
        const result = await pop3Read(incoming, id, limit);
        if (!id) return result;
        const parsed = await simpleParser(result, { skipHtmlToText: true, skipTextToHtml: true });
        return JSON.stringify({ id, from: parsed.from?.text, subject: parsed.subject, text: parsed.text?.slice(0, 100_000) });
      }
      const client = new ImapFlow({ host: incoming.host, port: incoming.port, secure: true,
        auth: { user: incoming.username, pass: incoming.password }, logger: false,
        ...(egressProxy() ? { proxy: egressProxy()!.href } : {}),
        connectionTimeout: 15_000, socketTimeout: 30_000 });
      try {
        await client.connect();
        const lock = await client.getMailboxLock(mailbox, { readOnly: true });
        try {
          if (id) {
            if (!/^\d+$/.test(id)) throw new Error("IMAP id musí být UID");
            const message = await client.fetchOne(id, { uid: true, envelope: true, bodyStructure: true, size: true }, { uid: true });
            if (!message) throw new Error("Zpráva nenalezena");
            if ((message.size ?? 0) > 10 * 1024 * 1024) throw new Error("Zpráva přesahuje 10 MB");
            const full = await client.fetchOne(id, { source: true }, { uid: true });
            if (!full || !full.source) throw new Error("Zpráva nemá obsah");
            const parsed = await simpleParser(full.source, { skipHtmlToText: true, skipTextToHtml: true });
            return JSON.stringify({ id, subject: parsed.subject, from: parsed.from?.text, text: parsed.text?.slice(0, 100_000) });
          }
          const count = client.mailbox ? client.mailbox.exists : 0;
          if (!count) return "[]";
          const messages = [];
          for await (const m of client.fetch(`${Math.max(1, count - limit + 1)}:*`, { uid: true, envelope: true })) messages.push({ id: String(m.uid), ...m.envelope });
          return JSON.stringify(messages.reverse());
        } finally { lock.release(); }
      } finally { client.close(); }
    }, { name: "mail_read", description: "Seznam posledních e-mailů nebo čtení zprávy podle id přes IMAP/POP3. POP3 id je UIDL. Nemění stav zpráv.", schema: z.object({ account: z.string(), mailbox: z.string().default("INBOX"), id: z.string().optional(), limit: z.number().int().min(1).max(50).default(20) }) }),
  ];
}
