import { createTransport } from "nodemailer";

export interface Mailer {
  send(message: { to: string; subject: string; text: string }): Promise<void>;
}

/** Email over SMTP (`smtp://user:pass@host:587` or `smtps://…:465`). */
export function smtpMailer(url: string, from: string): Mailer {
  const transport = createTransport(url);
  return {
    async send({ to, subject, text }) {
      await transport.sendMail({ from, to, subject, text });
    },
  };
}

/**
 * Email through Emailit's HTTP API (https://emailit.com), for clusters that block outgoing SMTP. Tracking is off: it
 * would rewrite the sign-in links.
 */
export function emailitMailer(apiKey: string, from: string, fetchFn: typeof fetch = fetch): Mailer {
  return {
    async send({ to, subject, text }) {
      const res = await fetchFn("https://api.emailit.com/v2/emails", {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ from, to, subject, text, tracking: false }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`Emailit refused the email: ${res.status} ${await res.text().catch(() => "")}`);
    },
  };
}

/** Development: prints the message instead of sending it. */
export const consoleMailer: Mailer = {
  async send({ to, subject, text }) {
    console.log(`[mail] To: ${to}\nSubject: ${subject}\n\n${text}\n`);
  },
};
