import { AIMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import { MediaReader, attachmentInput, attachmentMessage } from "@osiris/core/agent/attachments.ts";
import { createTestApp, createTestTenants } from "./helpers.ts";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jKuoAAAAASUVORK5CYII=", "base64");
function blankPdf() {
  let text = "%PDF-1.4\n";
  const offsets = [0];
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>"];
  objects.forEach((obj, i) => { offsets.push(Buffer.byteLength(text)); text += `${i + 1} 0 obj\n${obj}\nendobj\n`; });
  const xref = Buffer.byteLength(text);
  text += `xref\n0 4\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(text);
}
describe("chat attachments", () => {
  it("loads only the caller's thread files and passes images as image content", async () => {
    const { tenants, model } = createTestTenants([new AIMessage("Vidím obrázek.")]);
    const app = await createTestApp(tenants);
    const call = (path: string, init: RequestInit = {}) => app.request(`/api${path}`, { ...init, headers: { authorization: "Bearer bob:tenant=acme", "x-tenant-id": "acme", "content-type": "application/json" } });
    const { id } = await (await call("/threads", { method: "POST" })).json();
    const t = await tenants.get("acme");
    await t.files.write({ scope: "temp", threadId: id }, "photo.png", png);
    const message = `@osiris-attachments:${JSON.stringify({ text: "Co vidíš?", paths: ["photo.png"] })}`;
    const response = await call(`/threads/${id}/runs`, { method: "POST", body: JSON.stringify({ message }) });
    expect(await response.text()).toContain("Vidím obrázek");
    const history = await t.graph.getState({ configurable: { thread_id: id } });
    expect(JSON.stringify(history.values.messages)).not.toContain(png.toString("base64"));
    const human = model.calls[0]!.at(-1)!;
    expect(human.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: "image_url" })]));
    const other = await (await call("/threads", { method: "POST" })).json();
    await expect(attachmentMessage(t.files, t.media, other.id, "test", ["photo.png"], async () => {})).rejects.toThrow();
    await expect(attachmentMessage(t.files, t.media, id, "test", ["../photo.png"], async () => {})).rejects.toThrow();
    expect(() => attachmentInput('@osiris-attachments:{"text":"x","paths":[1]}')).toThrow();
  });
  it("uses fixed OCR/transcription endpoints, accounts for reported audio tokens and refuses provider failures", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const reader = new MediaReader("key", "audio-model", "ocr-model", (async (url, init) => {
      calls.push({ url: String(url), init: init! });
      return String(url).endsWith("ocr") ? Response.json({ pages: [{ markdown: "Obsah PDF" }] }) : Response.json({ text: "Přepis hlasu", usage: { total_tokens: 12 } });
    }) as typeof fetch);
    expect(await reader.extract(blankPdf(), "application/pdf")).toEqual({ text: "Obsah PDF", tokens: 0 });
    expect(await reader.extract(Buffer.from("OggS"), "audio/ogg")).toEqual({ text: "Přepis hlasu", tokens: 12 });
    expect(calls[0]!.url).toBe("https://api.mistral.ai/v1/ocr");
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({ model: "ocr-model", document: { type: "document_url" }, pages: [0] });
    expect(calls[1]!.init.body).toBeInstanceOf(FormData);
    const failed = new MediaReader("key", undefined, undefined, (async () => new Response(null, { status: 500 })) as typeof fetch);
    await expect(failed.extract(blankPdf(), "application/pdf")).rejects.toThrow("HTTP 500");
    await expect(new MediaReader(undefined).extract(png, "audio/ogg")).rejects.toThrow("MISTRAL_API_KEY");
  });
  it("offers files from the current thread only", async () => {
    const { tenants } = createTestTenants([]);
    const t = await tenants.get("acme");
    const tools = t.builtinTools.map(([, tool]) => tool);
    const send = tools.find(tool => tool.name === "send_chat_file")!;
    await t.files.write({ scope: "temp", threadId: "t1" }, "file.txt", Buffer.from("Obsah"));
    expect(JSON.parse(await send.invoke({ scope: "temp", path: "file.txt" }, { configurable: { tenant_id: "acme", thread_id: "t1", user_id: "bob", role: "member", channel: "whatsapp" } }))).toMatchObject({ file: { path: "file.txt", scope: "temp" } });
    await expect(send.invoke({ scope: "temp", path: "file.txt" }, { configurable: { tenant_id: "acme", thread_id: "t2", user_id: "bob", role: "member", channel: "whatsapp" } })).rejects.toThrow();
  });
});
