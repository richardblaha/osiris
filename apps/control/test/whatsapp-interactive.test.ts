import { describe, expect, it } from "vitest";
import { WhatsAppClient, inboundMessages, deliveryStatuses } from "../src/whatsapp/cloud-api.ts";
import { createTestControl } from "./helpers.ts";
import type { ChatQuestion } from "@osiris/shared";

const q: ChatQuestion = { id: "q1", title: "Odeslat nabídku?", fields: [{ name: "confirm", label: "Potvrzení", type: "boolean", required: true }], state: "open", expiresAt: Date.now() + 60000 };
const payload = (message: unknown) => ({ entry: [{ changes: [{ value: { metadata: { phone_number_id: "p1" }, messages: [message] } }] }] });
describe("WhatsApp interactive messages", () => {
  it("round-trips reply buttons and list selections into typed question answers", async () => {
    const bodies: Record<string, any>[] = [];
    const client = new WhatsAppClient("token", (async (_, init) => { bodies.push(JSON.parse(String(init?.body))); return Response.json({ messages: [{ id: "sent1" }] }); }) as typeof fetch);
    await client.sendQuestion("p1", "420777111222", q, "https://osiris.example/chat");
    const button = bodies[0]!.interactive.action.buttons[0].reply;
    expect(bodies[0]!.interactive.type).toBe("button");
    const [reply] = inboundMessages(payload({ id: "m1", from: "420777111222", type: "interactive", interactive: { button_reply: { id: button.id, title: button.title } } }));
    expect(reply!.text).toContain('"confirm":true');
    expect(reply!.text).toContain('"id":"q1"');
    const choices: ChatQuestion = { ...q, fields: [{ name: "service", label: "Služba", type: "select", required: true, options: [1, 2, 3, 4].map(n => ({ value: String(n), label: `Služba ${n}` })) }] };
    await client.sendQuestion("p1", "420777111222", choices, "https://osiris.example/chat");
    expect(bodies[1]!.interactive.type).toBe("list");
    expect(bodies[1]!.interactive.action.sections[0].rows).toHaveLength(4);
  });
  it("sends configured native Flows, decodes results and falls back to a PWA form", async () => {
    const bodies: Record<string, any>[] = [];
    const fetchFn = (async (_, init) => { bodies.push(JSON.parse(String(init?.body))); return Response.json({}); }) as typeof fetch;
    const form: ChatQuestion = { ...q, fields: [{ name: "name", label: "Jméno", type: "text", required: true }, { name: "date", label: "Datum", type: "date", required: true }] };
    const client = new WhatsAppClient("token", fetchFn, { flows: [{ id: "123", screen: "FORM", fields: [{ name: "name", type: "text" }, { name: "date", type: "date" }] }] });
    await client.sendQuestion("p1", "420777111222", form, "https://osiris.example/chat");
    expect(bodies[0]!.interactive.action.parameters).toMatchObject({ flow_id: "123", flow_token: "q1" });
    const [reply] = inboundMessages(payload({ id: "m2", from: "420777111222", type: "interactive", interactive: { nfm_reply: { response_json: JSON.stringify({ flow_token: "q1", name: "Jan", date: "2026-10-22" }) } } }));
    expect(JSON.parse(reply!.text!.slice("@osiris-answer:".length))).toEqual({ id: "q1", values: { name: "Jan", date: "2026-10-22" } });
    await new WhatsAppClient("token", fetchFn).sendQuestion("p1", "420777111222", form, "https://osiris.example/chat");
    expect(bodies[1]!.text.body).toContain("https://osiris.example/chat");
  });
  it("persists media metadata and monotonic delivery receipts", async () => {
    const control = await createTestControl();
    const [message] = inboundMessages(payload({ id: "media1", from: "420777111222", type: "audio", audio: { id: "a1", mime_type: "audio/ogg" } }));
    await control.inbox.enqueue([message!]);
    expect((await control.inbox.claim())?.media).toEqual({ id: "a1", mime: "audio/ogg" });
    const receipt = (status: string, timestamp: string) => deliveryStatuses({ entry: [{ changes: [{ value: { metadata: { phone_number_id: "p1" }, statuses: [{ id: "s1", status, timestamp, recipient_id: "420777111222" }] } }] }] });
    await control.inbox.statuses(receipt("read", "100"));
    await control.inbox.statuses(receipt("delivered", "99"));
    await control.inbox.statuses(receipt("sent", "101"));
    expect((await control.db.query<{ status: string }>("SELECT status FROM wa_deliveries WHERE message_id='s1'"))[0]!.status).toBe("read");
  });
  it("uploads outbound files as multipart and sends their media IDs", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const client = new WhatsAppClient("token", (async (url, init) => {
      calls.push({ url: String(url), init: init! });
      return Response.json(String(url).endsWith("/media") ? { id: "uploaded1" } : { messages: [{ id: "sent1" }] });
    }) as typeof fetch);
    await client.sendFile("p1", "420777111222", { data: Buffer.from("%PDF-1.4"), mime: "application/pdf", name: "nabidka.pdf" });
    expect(calls[0]!.init.body).toBeInstanceOf(FormData);
    expect(JSON.parse(String(calls[1]!.init.body))).toMatchObject({ type: "document", document: { id: "uploaded1", filename: "nabidka.pdf" } });
  });

  it("uses approved notification templates only when configured", async () => {
    const bodies: Record<string, any>[] = [];
    const fetchFn = (async (_, init) => { bodies.push(JSON.parse(String(init?.body))); return Response.json({}); }) as typeof fetch;
    expect(await new WhatsAppClient("token", fetchFn).sendNotification("p1", "420777111222", "Souhrn zakázek", "t/acme/chat/thread1")).toBe(false);
    expect(bodies).toHaveLength(0);
    expect(await new WhatsAppClient("token", fetchFn, { notificationTemplate: { name: "osiris_result", language: "cs" } }).sendNotification("p1", "420777111222", "Souhrn zakázek", "t/acme/chat/thread1")).toBe(true);
    expect(bodies[0]).toMatchObject({ type: "template", template: { name: "osiris_result", language: { code: "cs" }, components: [
      { type: "body", parameters: [{ type: "text", text: "Souhrn zakázek" }] },
      { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: "t/acme/chat/thread1" }] },
    ] } });
  });
});
