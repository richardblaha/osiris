import { AIMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import { createTestApp, createTestTenants } from "./helpers.ts";

const definition = { title: "Potvrdit odeslání nabídky?", fields: [{ name: "confirm", label: "Odeslat", type: "boolean" as const, required: true }] };
const ask = (args = definition) => new AIMessage({ content: "", tool_calls: [{ id: "ask-1", name: "ask_user", args }] });
async function setup(script: AIMessage[]) {
  const { tenants, model } = createTestTenants(script);
  const app = await createTestApp(tenants);
  const as = (user: string) => (path: string, init: RequestInit = {}) => app.request(`/api${path}`, { ...init, headers: { authorization: `Bearer ${user}:tenant=acme`, "x-tenant-id": "acme", "content-type": "application/json" } });
  const bob = as("bob");
  const { id } = await (await bob("/threads", { method: "POST" })).json();
  const send = async (message: string) => { const r = await bob(`/threads/${id}/runs`, { method: "POST", body: JSON.stringify({ message }) }); return { status: r.status, body: await r.text() }; };
  return { tenants, model, bob, eva: as("eva"), id, send };
}

describe("durable chat questions", () => {
  it("pauses after asking, persists the form, validates answers and resumes only once", async () => {
    const { tenants, model, bob, eva, id, send } = await setup([ask(), new AIMessage("Neodesílám.")]);
    const first = await send("Připrav nabídku a zeptej se na odeslání");
    expect(first.status).toBe(200);
    expect(first.body).toContain('"type":"tool-result"');
    expect(model.calls).toHaveLength(1);
    const tenant = await tenants.get("acme");
    const q = (await tenant.questions.get("dev:bob", id))!;
    expect(q.state).toBe("open");
    expect((await bob(`/threads/${id}/questions/${q.id}`)).status).toBe(200);
    expect((await eva(`/threads/${id}/questions/${q.id}`)).status).toBe(404);
    expect((await send(`@osiris-answer:${JSON.stringify({ id: q.id, values: { confirm: "nonsense" } })}`)).status).toBe(400);
    expect(model.calls).toHaveLength(1);
    expect((await send(`@osiris-answer:${JSON.stringify({ id: q.id, values: { confirm: false } })}`)).body).toContain("Neodesílám");
    expect(model.calls).toHaveLength(2);
    expect(model.calls[1]!.some(m => m.text.includes('"confirm":false'))).toBe(true);
    expect((await tenant.questions.get("dev:bob", id, q.id))?.state).toBe("answered");
    expect((await send(`@osiris-answer:${JSON.stringify({ id: q.id, values: { confirm: true } })}`)).status).toBe(400);
  });

  it("validates field types, expiry and cancellation", async () => {
    const { tenants, id } = await setup([]);
    const tenant = await tenants.get("acme");
    const q = await tenant.questions.create("dev:bob", id, { title: "Zakázka", fields: [
      { name: "date", label: "Datum", type: "date", required: true },
      { name: "service", label: "Služba", type: "select", required: true, options: [{ value: "repair", label: "Oprava" }] },
    ] });
    await expect(tenant.questions.resolve("dev:eva", id, q.id, {}, false)).rejects.toThrow();
    await expect(tenant.questions.resolve("dev:bob", id, q.id, { date: "2026-02-30", service: "repair" }, false)).rejects.toThrow();
    await expect(tenant.questions.resolve("dev:bob", id, q.id, { date: "2026-10-22", service: "hack" }, false)).rejects.toThrow();
    const cancel = await tenant.questions.prepare("dev:bob", id, "/zrusit");
    expect(cancel).toContain("Neprováděj akci");
    expect((await tenant.questions.get("dev:bob", id, q.id))?.state).toBe("cancelled");
    const next = await tenant.questions.create("dev:bob", id, definition);
    await tenant.db.execute({ sql: "UPDATE chat_questions SET expires_at=0 WHERE id=?", args: [next.id] });
    await expect(tenant.questions.resolve("dev:bob", id, next.id, { confirm: true }, false)).rejects.toThrow();
    expect((await tenant.questions.get("dev:bob", id, next.id))?.state).toBe("expired");
    await expect(tenant.questions.prepare("dev:bob", id, "ano")).rejects.toThrow("vypršela");
    expect(await tenant.questions.prepare("dev:bob", id, "Nová otázka")).toBe("Nová otázka");
  });

  it("never executes mutating tools alongside a question", async () => {
    const combined = ask();
    combined.tool_calls!.push({ id: "write-1", name: "remember", args: { content: "Nemělo se uložit" } });
    const { tenants, model, send } = await setup([combined, new AIMessage("Potřebuji se nejprve zeptat.")]);
    await send("Test");
    expect(model.calls).toHaveLength(2);
    const tenant = await tenants.get("acme");
    expect(await tenant.memory.list("dev:bob")).toEqual([]);
  });

  it("accepts WhatsApp-style text choices and enforces single submission", async () => {
    const { tenants, id } = await setup([]);
    const tenant = await tenants.get("acme");
    const q = await tenant.questions.create("dev:bob", id, definition);
    const results = await Promise.allSettled([tenant.questions.prepare("dev:bob", id, "ano"), tenant.questions.prepare("dev:bob", id, "ne")]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect((await tenant.questions.get("dev:bob", id, q.id))?.state).toBe("answered");
  });
});
