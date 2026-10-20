import { AIMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import { tenantAudience } from "@osiris/platform/internal-auth.ts";
import { estimate } from "@osiris/core/public/assistant.ts";
import type { RunEvent } from "@osiris/shared";
import { createTestApp, createTestTenants } from "./helpers.ts";

const text = (s: string) => Buffer.from(s);

async function setup(script: AIMessage[] = []) {
  const notified: { subject: string; text: string }[] = [];
  const { tenants, model } = createTestTenants(script, [], undefined, { notifyAdmins: async (subject, text) => void notified.push({ subject, text }) });
  const app = await createTestApp(tenants);
  const admin = (path: string, init: RequestInit = {}) =>
    app.request(`/api${path}`, { ...init, headers: { authorization: "Bearer acme", "x-tenant-id": "acme", "content-type": "application/json", ...init.headers } });
  /** A customer, as the gateway passes them on: a visitor id, no user. */
  const visitor = (id: string) => async (path: string, init: RequestInit = {}) => {
    const authorization = await app.signer.header(tenantAudience("acme"), { tenant: "acme", visitor: id, channel: "public" });
    return (await app.runtime("acme")).request(`/public${path}`, { ...init, headers: { authorization, "content-type": "application/json", ...init.headers } });
  };
  const chat = async (who: ReturnType<typeof visitor>, message: string, thread?: string) => {
    const id = thread ?? (await (await who("/threads", { method: "POST" })).json()).id;
    const res = await who(`/threads/${id}/runs`, { method: "POST", body: JSON.stringify({ message }) });
    const events = (await res.text()).split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)) as RunEvent);
    return { id, text: events.flatMap((e) => (e.type === "text-delta" ? [e.delta] : [])).join("") };
  };
  return { tenants, model, admin, visitor, chat, notified };
}

describe("the public assistant", () => {
  it("is off until the tenant admin switches it on", async () => {
    const { admin, visitor } = await setup();
    const anna = visitor("anna-visitor-123456");
    expect(await (await anna("/info")).json()).toMatchObject({ enabled: false });
    expect((await anna("/threads", { method: "POST" })).status).toBe(404);
    // Customers never reach the members' API.
    expect((await anna("/../api/threads")).status).not.toBe(200);
    const settings = { enabled: true, title: "Elektro Novák", greeting: "Dobrý den!", tools: ["estimate_price", "create_inquiry"], tokensPerMonth: null };
    expect((await admin("/public-assistant", { method: "PUT", body: JSON.stringify(settings) })).status).toBe(200);
    expect(await (await anna("/info")).json()).toEqual({ enabled: true, title: "Elektro Novák", greeting: "Dobrý den!" });
  });

  it("knows only knowledge/public/, gets only its tools and its own prompt, and keeps visitors apart", async () => {
    const { tenants, model, admin, visitor, chat } = await setup([new AIMessage("Dobrý den."), new AIMessage("Dobrý den.")]);
    await admin("/public-assistant", {
      method: "PUT",
      body: JSON.stringify({ enabled: true, title: "Elektro Novák", greeting: "", tools: ["estimate_price"], tokensPerMonth: null }),
    });
    const acme = await tenants.get("acme");
    await acme.files.write({ scope: "tenant" }, "knowledge/public/cenik.md", text("# Ceník\nZásuvka montáž 450 Kč za kus."));
    await acme.files.write({ scope: "tenant" }, "knowledge/interni.md", text("Marže na zásuvkách je 60 %."));
    // Search for customers stays in the public folder.
    expect((await acme.knowledge.search("zásuvka", "", 5, { under: "knowledge/public" })).map((r) => r.path)).toEqual(["knowledge/public/cenik.md"]);

    const bound: string[][] = [];
    model.bindTools = ((tools: { name: string }[]) => (bound.push(tools.map((t) => t.name)), model)) as never;
    const anna = visitor("anna-visitor-123456");
    const { id, text: answer } = await chat(anna, "Kolik stojí zásuvka?");
    expect(answer).toBe("Dobrý den.");
    expect(bound[0]!.sort()).toEqual(["estimate_price", "search_knowledge"]);
    const prompt = model.calls[0]![0]!.text;
    expect(prompt).toContain("asistent firmy Elektro Novák pro její zákazníky");
    expect(prompt).not.toContain("# PAMĚŤ");

    // Another visitor can't read or continue Anna's chat.
    const eve = visitor("eve-visitor-1234567");
    expect((await eve(`/threads/${id}/messages`)).status).toBe(404);
    expect((await eve(`/threads/${id}/runs`, { method: "POST", body: JSON.stringify({ message: "Ahoj" }) })).status).toBe(404);
    // And members don't see customers' chats among their own.
    expect(await (await admin("/threads")).json()).toEqual([]);
  });

  it("takes an inquiry, tells the admins and lists it for the tenant", async () => {
    const { tenants, admin, visitor, chat, notified } = await setup();
    await admin("/public-assistant", { method: "PUT", body: JSON.stringify({ enabled: true, title: "", greeting: "", tools: ["create_inquiry"], tokensPerMonth: null }) });
    const anna = visitor("anna-visitor-123456");
    await chat(anna, "Chci nabídku");
    const acme = await tenants.get("acme");
    const tool = (await acme.graph.getGraph()) && (await import("@osiris/core/public/assistant.ts")).publicTools(
      { knowledge: acme.knowledge, inquiries: acme.inquiries, skills: acme.skills, notify: async (i) => void notified.push({ subject: i.name, text: i.description }) },
      ["create_inquiry"],
    ).find((t) => t.name === "create_inquiry")!;
    const config = { configurable: { thread_id: "t1", tenant_id: "acme", user_id: "public:anna-visitor-123456", role: "member", channel: "public" } };
    expect(await tool.invoke({ name: "Anna", contact: "777 123 456", description: "Výměna 5 zásuvek v Brně" }, config)).toContain("předaná");
    expect(notified.at(-1)).toEqual({ subject: "Anna", text: "Výměna 5 zásuvek v Brně" });
    const list = await (await admin("/inquiries")).json();
    expect(list).toMatchObject([{ name: "Anna", contact: "777 123 456", status: "new", threadId: "t1" }]);
    expect((await admin(`/inquiries/${list[0].id}`, { method: "PATCH", body: JSON.stringify({ status: "done" }) })).status).toBe(204);
    expect((await (await admin("/inquiries")).json())[0].status).toBe("done");
  });

  it("estimates prices exactly, with VAT, as an estimate", () => {
    const out = estimate({
      items: [
        { name: "Montáž zásuvky", quantity: 5, unit: "ks", unit_price: 450 },
        { name: "Kabel CYKY", quantity: 12.5, unit: "m", unit_price: 38.4 },
      ],
      vat_percent: 21,
      prices_include_vat: false,
      extra: 300,
    }).replace(/\u00a0/g, " ");
    expect(out).toContain("Montáž zásuvky: 5 ks × 450 Kč = 2 250 Kč");
    expect(out).toContain("Bez DPH: 3 030 Kč");
    expect(out).toContain("DPH 21 %: 636,3 Kč");
    expect(out).toContain("Celkem s DPH: 3 666,3 Kč");
    expect(out).toContain("orientační odhad");
  });
});
