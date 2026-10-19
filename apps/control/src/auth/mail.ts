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

/** Development: prints the message instead of sending it. */
export const consoleMailer: Mailer = {
  async send({ to, subject, text }) {
    console.log(`[mail] To: ${to}\nSubject: ${subject}\n\n${text}\n`);
  },
};
