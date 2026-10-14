import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

// WhatsApp Business Cloud API (Meta Graph API).

const GRAPH_API = "https://graph.facebook.com/v23.0";
/** WhatsApp's limit for a text message body. */
const MAX_TEXT = 4096;

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Checks Meta's `X-Hub-Signature-256` header: HMAC-SHA256 of the raw request body with the app secret. */
export function verifySignature(appSecret: string, body: Buffer, header: string | undefined): boolean {
  if (!header) return false;
  return safeEqual(`sha256=${createHmac("sha256", appSecret).update(body).digest("hex")}`, header);
}

export interface InboundMessage {
  id: string;
  /** Sender's WhatsApp number, digits only (e.g. 420777123456). */
  from: string;
  /** Our business number that received it; replies are sent from the same one. */
  phoneNumberId: string;
  type: string;
  text?: string;
}

const webhookPayload = z.object({
  entry: z.array(
    z.object({
      changes: z.array(
        z.object({
          value: z.object({
            metadata: z.object({ phone_number_id: z.string() }).optional(),
            messages: z
              .array(z.object({ id: z.string(), from: z.string(), type: z.string(), text: z.object({ body: z.string() }).optional() }))
              .optional(),
          }),
        }),
      ),
    }),
  ),
});

/** Incoming user messages in a webhook payload. Delivery statuses and anything unrecognised are skipped. */
export function inboundMessages(payload: unknown): InboundMessage[] {
  const parsed = webhookPayload.safeParse(payload);
  if (!parsed.success) return [];
  return parsed.data.entry.flatMap((entry) =>
    entry.changes.flatMap(({ value }) =>
      value.metadata
        ? (value.messages ?? []).map((m) => ({
            id: m.id,
            from: m.from,
            phoneNumberId: value.metadata!.phone_number_id,
            type: m.type,
            text: m.text?.body,
          }))
        : [],
    ),
  );
}

/** Splits a reply into WhatsApp-sized messages, preferably at line breaks, then at spaces. */
export function splitText(text: string, max = MAX_TEXT): string[] {
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max / 2) cut = rest.lastIndexOf(" ", max);
    if (cut < max / 2) cut = max;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

export class WhatsAppClient {
  constructor(
    private readonly accessToken: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async sendText(phoneNumberId: string, to: string, text: string): Promise<void> {
    for (const body of splitText(text)) {
      await this.post(phoneNumberId, { messaging_product: "whatsapp", recipient_type: "individual", to, type: "text", text: { body } });
    }
  }

  /** Marks the message read and shows "typing…" until the reply arrives (WhatsApp hides it after 25 s). */
  async markRead(phoneNumberId: string, messageId: string): Promise<void> {
    await this.post(phoneNumberId, {
      messaging_product: "whatsapp",
      status: "read",
      message_id: messageId,
      typing_indicator: { type: "text" },
    });
  }

  private async post(phoneNumberId: string, body: object): Promise<void> {
    const res = await this.fetchFn(`${GRAPH_API}/${encodeURIComponent(phoneNumberId)}/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.accessToken}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`WhatsApp API ${res.status}: ${(await res.text()).slice(0, 500)}`);
  }
}
