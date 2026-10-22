import type { ChatQuestion } from "@osiris/shared";
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
  media?: { id: string; mime: string; filename?: string; caption?: string };
}

const webhookPayload = z.object({
  entry: z.array(
    z.object({
      changes: z.array(
        z.object({
          value: z.object({
            metadata: z.object({ phone_number_id: z.string() }).optional(),
            messages: z
              .array(z.looseObject({ id: z.string(), from: z.string(), type: z.string(), text: z.object({ body: z.string() }).optional() }))
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
            text: inboundText(m),
            media: inboundMedia(m),
          }))
        : [],
    ),
  );
}

function inboundText(m: Record<string, unknown>): string | undefined {
  if (m.type === "text") return (m.text as { body?: string } | undefined)?.body;
  if (m.type === "button") return (m.button as { payload?: string } | undefined)?.payload;
  if (m.type !== "interactive") return undefined;
  const i = m.interactive as { button_reply?: { id: string }; list_reply?: { id: string }; nfm_reply?: { response_json: string } } | undefined;
  if (i?.nfm_reply) {
    try { const { flow_token, ...values } = JSON.parse(i.nfm_reply.response_json); return `@osiris-answer:${JSON.stringify({ id: flow_token, values })}`; } catch { return undefined; }
  }
  return i?.button_reply?.id ?? i?.list_reply?.id;
}
function inboundMedia(m: Record<string, unknown>): InboundMessage["media"] {
  if (!["image", "document", "audio"].includes(String(m.type))) return undefined;
  const media = m[String(m.type)] as { id?: string; mime_type?: string; filename?: string; caption?: string } | undefined;
  return media?.id && media.mime_type ? { id: media.id, mime: media.mime_type, filename: media.filename, caption: media.caption } : undefined;
}
export function deliveryStatuses(payload: unknown): { id: string; status: string; at: number; recipient: string; phoneNumberId: string; error?: string }[] {
  const parsed = z.object({ entry: z.array(z.object({ changes: z.array(z.object({ value: z.object({ metadata: z.object({ phone_number_id: z.string() }).optional(), statuses: z.array(z.object({ id: z.string(), status: z.enum(["sent", "delivered", "read", "failed"]), timestamp: z.string().regex(/^\d+$/), recipient_id: z.string(), errors: z.array(z.object({ code: z.number() })).optional() })).optional() }) })) })) }).safeParse(payload);
  return parsed.success ? parsed.data.entry.flatMap(e => e.changes.flatMap(({ value: v }) => (v.statuses ?? []).map(s => ({ id: s.id, status: s.status, at: Number(s.timestamp) * 1000, recipient: s.recipient_id, phoneNumberId: v.metadata?.phone_number_id ?? "", error: s.errors?.map(e => String(e.code)).join(",") })))) : [];
}

export interface FlowMapping { id: string; screen: string; fields: { name: string; type: string }[] }
export interface WhatsAppOptions {
  flows?: FlowMapping[];
  onSent?: (id: string, phoneNumberId: string, to: string) => Promise<void>;
  notificationTemplate?: { name: string; language: string };
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

export class WhatsAppApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export class WhatsAppClient {
  constructor(
    private readonly accessToken: string,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly options: WhatsAppOptions = {},
  ) {}

  async sendText(phoneNumberId: string, to: string, text: string): Promise<void> {
    for (const body of splitText(text)) {
      await this.post(phoneNumberId, { messaging_product: "whatsapp", recipient_type: "individual", to, type: "text", text: { body } });
    }
  }

  async sendQuestion(phone: string, to: string, q: ChatQuestion, fallbackUrl: string) {
    const encode = (value: unknown, name: string) => `@osiris-answer:${JSON.stringify({ id: q.id, values: { [name]: value } })}`;
    const f = q.fields[0]!;
    const choices = q.fields.length === 1 && f.type === "boolean" ? [{ value: true, label: "Ano" }, { value: false, label: "Ne" }]
      : q.fields.length === 1 && f.type === "select" ? f.options ?? [] : [];
    const base = { messaging_product: "whatsapp", to, type: "interactive" };
    if (choices.length && choices.length <= 3 && choices.every(c => c.label.length <= 20)) {
      await this.post(phone, { ...base, interactive: { type: "button", body: { text: q.title }, action: { buttons: choices.map(c => ({ type: "reply", reply: { id: encode(c.value, f.name), title: c.label } })) } } });
      return;
    }
    if (choices.length && choices.every(c => c.label.length <= 24)) {
      await this.post(phone, { ...base, interactive: { type: "list", body: { text: q.title }, action: { button: "Vybrat odpověď", sections: [{ rows: choices.map(c => ({ id: encode(c.value, f.name), title: c.label })) }] } } });
      return;
    }
    const flow = this.options.flows?.find(flow => flow.fields.length === q.fields.length && flow.fields.every((f, i) => q.fields[i]?.name === f.name && q.fields[i]?.type === f.type));
    if (flow) {
      const data = Object.fromEntries(q.fields.flatMap(f => [[`${f.name}_label`, f.label], ...(f.options ? [[`${f.name}_options`, f.options.map(o => ({ id: o.value, title: o.label }))]] : [])]));
      try {
        await this.post(phone, { ...base, interactive: { type: "flow", body: { text: q.title }, action: { name: "flow", parameters: { flow_message_version: "3", flow_id: flow.id, flow_token: q.id, flow_cta: "Vyplnit", flow_action: "navigate", flow_action_payload: { screen: flow.screen, data: { title: q.title, ...data } } } } } });
        return;
      } catch { /* Meta eligibility/template errors: always leave the user a working PWA form. */ }
    }
    await this.sendText(phone, to, `${q.title}\n${q.fields.map(f => `${f.label}${f.options ? ` (${f.options.map((o, i) => `${i + 1}. ${o.label}`).join(", ")})` : ""}`).join("\n")}\n${q.fields.length === 1 ? "Odpověz zprávou, nebo otevři formulář." : "Otevři formulář:"}\n${fallbackUrl}\n/zrusit — zrušit otázku`);
  }
  async sendNotification(phone: string, to: string, title: string, detailPath: string) {
    const template = this.options.notificationTemplate;
    if (!template) return false;
    await this.post(phone, { messaging_product: "whatsapp", to, type: "template", template: { name: template.name, language: { code: template.language }, components: [{ type: "body", parameters: [{ type: "text", text: title.replace(/\s+/g, " ").trim().slice(0, 200) || "Plánovaná úloha" }] }, { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: detailPath }] }] } });
    return true;
  }
  async sendFile(phone: string, to: string, file: { data: Buffer; mime: string; name: string }) {
    const form = new FormData();
    form.set("messaging_product", "whatsapp");
    form.set("file", new Blob([new Uint8Array(file.data)], { type: file.mime }), file.name);
    const uploaded = await this.fetchFn(`${GRAPH_API}/${encodeURIComponent(phone)}/media`, { method: "POST", headers: { authorization: `Bearer ${this.accessToken}` }, body: form, signal: AbortSignal.timeout(60_000) });
    if (!uploaded.ok) throw new WhatsAppApiError(uploaded.status, "WhatsApp media upload failed");
    const { id } = await uploaded.json() as { id: string };
    const type = ["image/png", "image/jpeg"].includes(file.mime) ? "image" : file.mime.startsWith("audio/") ? "audio" : "document";
    await this.post(phone, { messaging_product: "whatsapp", to, type, [type]: { id, ...(type === "document" ? { filename: file.name } : {}) } });
  }
  async downloadMedia(id: string): Promise<{ data: Buffer; mime: string }> {
    const metadata = await this.fetchFn(`${GRAPH_API}/${encodeURIComponent(id)}`, { headers: { authorization: `Bearer ${this.accessToken}` }, signal: AbortSignal.timeout(15_000) });
    if (!metadata.ok) throw new WhatsAppApiError(metadata.status, "WhatsApp media metadata failed");
    const info = await metadata.json() as { url: string; mime_type: string; file_size: number };
    const url = new URL(info.url);
    if (url.protocol !== "https:" || !(url.hostname === "lookaside.fbsbx.com" || url.hostname.endsWith(".fbcdn.net")) || url.username || url.password || info.file_size > 20 * 1024 * 1024) throw new Error("Invalid WhatsApp media URL/size");
    const response = await this.fetchFn(url, { headers: { authorization: `Bearer ${this.accessToken}` }, redirect: "error", signal: AbortSignal.timeout(30_000) });
    if (!response.ok || !response.body) throw new WhatsAppApiError(response.status, "WhatsApp media download failed");
    const chunks: Uint8Array[] = []; let size = 0;
    for await (const chunk of response.body) { size += chunk.length; if (size > 20 * 1024 * 1024) throw new Error("Media too large"); chunks.push(chunk); }
    return { data: Buffer.concat(chunks), mime: info.mime_type };
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
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new WhatsAppApiError(res.status, `WhatsApp API ${res.status}: ${(await res.text()).slice(0, 500)}`);
    const result = await res.json().catch(() => ({})) as { messages?: { id: string }[] };
    const out = body as { to?: string };
    for (const message of result.messages ?? []) if (out.to) await this.options.onSent?.(message.id, phoneNumberId, out.to);
  }
}
