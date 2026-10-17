import { Hono } from "hono";
import { inboundMessages, safeEqual, verifySignature } from "./cloud-api.ts";
import type { Inbox } from "./inbox.ts";

export interface WhatsAppWebhookOptions {
  inbox: Inbox;
  /** Our own string, entered as "Verify token" in the Meta app's webhook settings. */
  verifyToken: string;
  /** The Meta app's secret; signs every webhook request. */
  appSecret: string;
}

/**
 * The single WhatsApp webhook for all tenants (`/webhooks/whatsapp`). Not under `/api`: Meta sends no bearer token,
 * requests are authenticated by their signature instead, and the user and tenant come from the sender's number.
 */
export function whatsappWebhook({ inbox, verifyToken, appSecret }: WhatsAppWebhookOptions) {
  return (
    new Hono()
      // Meta verifies the URL once, when the webhook is saved.
      .get("/", (c) => {
        const token = c.req.query("hub.verify_token") ?? "";
        if (c.req.query("hub.mode") !== "subscribe" || !safeEqual(token, verifyToken)) return c.text("Forbidden", 403);
        return c.text(c.req.query("hub.challenge") ?? "");
      })

      .post("/", async (c) => {
        const body = Buffer.from(await c.req.arrayBuffer());
        if (!verifySignature(appSecret, body, c.req.header("x-hub-signature-256"))) return c.text("Invalid signature", 401);
        let payload: unknown;
        try {
          payload = JSON.parse(body.toString("utf8"));
        } catch {
          return c.text("Invalid JSON", 400);
        }
        // Stored durably, then answered at once; Meta redelivers anything not acknowledged within a few seconds, and
        // redeliveries are dropped by message id. The inbox worker (any replica) handles the messages.
        await inbox.enqueue(inboundMessages(payload));
        return c.body(null, 200);
      })
  );
}
