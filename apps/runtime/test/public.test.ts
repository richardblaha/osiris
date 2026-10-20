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
  const chat = async (who: ReturnType<typeof visitor>, message: string, assistant = "web", thread?: string) => {
    const id = thread ?? (await (await who(`/${assistant}/threads`, { method: "POST" })).json()).id;
    const res = await who(`/${assistant}/threads/${id}/runs`, { method: "POST", body: JSON.stringify({ message }) });
    const events = (await res.text()).split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)) as RunEvent);
    return { id, text: events.flatMap((e) => (e.type === "text-delta" ? [e.delta] : [])).join("") };
  };
  return { tenants, model, admin, visitor, chat, notified };
}

const assistant = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ enabled: true, title: "", greeting: "", knowledge: [], memories: [], skills: [], tools: [], tokensPerMonth: null, ...over });

describe("public assistants", () => {
  it("are off until the tenant admin switches one on", async () => {
    const { admin, visitor } = await setup();
    const anna = visitor("anna-visitor-123456");
    expect(await (await anna("/web/info")).json()).toMatchObject({ enabled: false });
    expect((await anna("/web/threads", { method: "POST" })).status).toBe(404);
    // Customers never reach the members' API.
    expect((await anna("/../api/threads")).status).not.toBe(200);
    expect((await admin("/public-assistants/web", { method: "PUT", body: assistant({ title: "Elektro Novák", greeting: "Dobrý den!", enabled: false }) })).status).toBe(200);
    expect(await (await anna("/web/info")).json()).toMatchObject({ enabled: false });
    await admin("/public-assistants/web", { method: "PUT", body: assistant({ title: "Elektro Novák", greeting: "Dobrý den!" }) });
    expect(await (await anna("/web/info")).json()).toEqual({ enabled: true, title: "Elektro Novák", greeting: "Dobrý den!" });
    // `_` is the first one (links from before there were several).
    expect(await (await anna("/_/info")).json()).toMatchObject({ enabled: true, title: "Elektro Novák" });
    expect((await admin("/public-assistants/Bad_Name", { method: "PUT", body: assistant() })).status).toBe(400);
    expect((await admin("/public-assistants/web", { method: "PUT", body: assistant({ knowledge: ["../interni.md"] }) })).status).toBe(400);
    expect((await admin("/public-assistants/web", { method: "DELETE" })).status).toBe(204);
    expect(await (await admin("/public-assistants")).json()).toEqual([]);
  });

  it("each know only their knowledge, memories and skills, get only their tools and keep visitors apart", async () => {
    const { tenants, model, admin, visitor, chat } = await setup([new AIMessage("Dobrý den."), new AIMessage("Dobrý den.")]);
    const acme = await tenants.get("acme");
    await acme.knowledge.putDocument("public/cenik.md", "# Ceník\nZásuvka montáž 450 Kč za kus.");
    await acme.knowledge.putDocument("public_x/jine.md", "Zásuvka jinde.");
    await acme.knowledge.putDocument("interni.md", "Marže na zásuvkách je 60 %.");
    await acme.files.write({ scope: "tenant" }, "skills/reklamace/SKILL.md", text("---\nname: reklamace\ndescription: Jak přijmout reklamaci\n---\n\nPostup."));
    const fact = await acme.memory.add("", "Otevřeno Po–Pá 8–16.", "tenant");
    await acme.memory.add("", "Interní: šéf je na dovolené.", "tenant");
    await admin("/public-assistants/eshop", {
      method: "PUT",
      body: assistant({ title: "Elektro Novák", knowledge: ["public"], memories: [fact.id], skills: ["reklamace"], tools: ["estimate_price"] }),
    });
    await admin("/public-assistants/servis", { method: "PUT", body: assistant({ title: "Servis" }) });
    // Search for customers stays in the picked folder (exactly: not public_x/).
    expect((await acme.knowledge.search("zásuvka", "", 5, { under: ["knowledge/public"] })).map((r) => r.path)).toEqual(["knowledge/public/cenik.md"]);

    const bound: string[][] = [];
    model.bindTools = ((tools: { name: string }[]) => (bound.push(tools.map((t) => t.name)), model)) as never;
    const anna = visitor("anna-visitor-123456");
    const { id, text: answer } = await chat(anna, "Kolik stojí zásuvka?", "eshop");
    expect(answer).toBe("Dobrý den.");
    expect(bound[0]!.sort()).toEqual(["estimate_price", "load_skill", "search_knowledge"]);
    const prompt = model.calls[0]![0]!.text;
    expect(prompt).toContain("asistent firmy Elektro Novák pro její zákazníky");
    expect(prompt).toContain("Otevřeno Po–Pá 8–16.");
    expect(prompt).not.toContain("šéf");
    expect(prompt).toContain("- reklamace: Jak přijmout reklamaci");
    expect(prompt).not.toContain("# PAMĚŤ");

    // The other assistant has nothing of that.
    await chat(anna, "Ahoj", "servis");
    expect(bound[1]).toEqual([]);
    expect(model.calls[1]![0]!.text).toContain("asistent firmy Servis");
    expect(model.calls[1]![0]!.text).not.toContain("Otevřeno");

    // Another visitor can't read or continue Anna's chat.
    const eve = visitor("eve-visitor-1234567");
    expect((await eve(`/eshop/threads/${id}/messages`)).status).toBe(404);
    expect((await eve(`/eshop/threads/${id}/runs`, { method: "POST", body: JSON.stringify({ message: "Ahoj" }) })).status).toBe(404);
    // And members don't see customers' chats among their own.
    expect(await (await admin("/threads")).json()).toEqual([]);
  });

  it("takes an inquiry, tells the admins and lists it for the tenant", async () => {
    const { tenants, admin, notified } = await setup();
    await admin("/public-assistants/web", { method: "PUT", body: assistant({ tools: ["create_inquiry"] }) });
    const acme = await tenants.get("acme");
    const tool = (await import("@osiris/core/public/assistant.ts"))
      .publicTools(
        { knowledge: acme.knowledge, inquiries: acme.inquiries, skills: acme.skills, notify: async (i) => void notified.push({ subject: i.name, text: i.description }) },
        { knowledge: [], skills: [], tools: ["create_inquiry"] },
      )
      .find((t) => t.name === "create_inquiry")!;
    const config = { configurable: { thread_id: "t1", tenant_id: "acme", user_id: "public:anna-visitor-123456", role: "member", channel: "public", assistant: "web" } };
    expect(await tool.invoke({ name: "Anna", contact: "777 123 456", description: "Výměna 5 zásuvek v Brně" }, config)).toContain("předaná");
    expect(notified.at(-1)).toEqual({ subject: "Anna", text: "Výměna 5 zásuvek v Brně" });
    const list = await (await admin("/inquiries")).json();
    expect(list).toMatchObject([{ name: "Anna", contact: "777 123 456", status: "new", threadId: "t1", assistant: "web" }]);
    expect((await admin(`/inquiries/${list[0].id}`, { method: "PATCH", body: JSON.stringify({ status: "done" }) })).status).toBe(204);
    expect((await (await admin("/inquiries")).json())[0].status).toBe("done");
  });

  it("moves the old single assistant to one named web", async () => {
    const { tenants, admin } = await setup();
    const acme = await tenants.get("acme");
    await acme.files.write({ scope: "tenant" }, "skills/cenik/SKILL.md", text("---\nname: cenik\ndescription: Ceník\npublic: true\n---\n\nPostup."));
    await acme.db.batch(
      [
        {
          sql: "INSERT INTO tenant_settings (key, value) VALUES ('public_assistant', ?)",
          args: [JSON.stringify({ enabled: true, title: "Novák", greeting: "Ahoj", tools: ["create_inquiry", "load_skill"], tokensPerMonth: 5 })],
        },
        "INSERT INTO assistant_profiles (owner, persona, guards) VALUES ('@public', NULL, 'Vykej.')",
        "INSERT INTO usage_months (month, tokens) VALUES ('public:2026-10', 7)",
      ],
      "write",
    );
    await acme.init();
    expect(await (await admin("/public-assistants")).json()).toEqual([
      { name: "web", enabled: true, title: "Novák", greeting: "Ahoj", knowledge: ["public"], memories: [], skills: ["cenik"], tools: ["create_inquiry"], tokensPerMonth: 5 },
    ]);
    expect((await (await admin("/guards")).json()).assistants).toEqual({ web: [{ name: "pravidlo-1", description: "Vykej.", rule: "Vykej." }] });
    expect(await acme.usage.tokens(Date.parse("2026-10-15"), { public: "web" })).toBe(7);
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
