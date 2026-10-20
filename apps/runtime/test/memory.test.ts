import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import { MemoryStore } from "@osiris/core/agent/memory.ts";
import { createTestDb, createTestTenants } from "./helpers.ts";

const ctx = (user: string, role: "admin" | "member") => ({
  thread_id: `t-${user}`,
  tenant_id: "a",
  user_id: user,
  role,
  channel: "web" as const,
});

describe("MemoryStore", () => {
  it("shows a user their own and shared memories, not other users' personal ones", async () => {
    const store = new MemoryStore(await createTestDb());
    await store.add("alice", "Alice tyká", "personal");
    await store.add("bob", "Bob vyká", "personal");
    const shared = await store.add("alice", "Firma není plátce DPH", "tenant");

    expect((await store.list("bob")).map((m) => m.content)).toEqual(["Firma není plátce DPH", "Bob vyká"]);
    expect(await store.delete(shared.id, "personal", "bob")).toBe(false);
    expect(await store.delete(shared.id, "tenant", "bob")).toBe(true);
  });
});

describe("memory tools", () => {
  it("remembers across threads and injects memories into the prompt", async () => {
    const { tenants, model } = createTestTenants([
      new AIMessage({ content: "", tool_calls: [{ id: "m1", name: "remember", args: { content: "Preferuje platbu převodem" } }] }),
      new AIMessage("Zapamatováno."),
      new AIMessage("Převodem."),
    ]);
    const { graph } = await tenants.get("a");

    await graph.invoke({ messages: [new HumanMessage("Platím převodem, pamatuj si to")] }, { configurable: ctx("alice", "member") });
    await graph.invoke({ messages: [new HumanMessage("Jak platím?")] }, { configurable: { ...ctx("alice", "member"), thread_id: "t2" } });

    expect(model.calls[2]?.[0]?.text).toMatch(/# PAMĚŤ[\s\S]*Preferuje platbu převodem/);
  });

  it("lets members remember facts for the whole tenant", async () => {
    const { tenants } = createTestTenants([
      new AIMessage({ content: "", tool_calls: [{ id: "m1", name: "remember", args: { content: "Sleva 5 % pro stálé zákazníky" } }] }),
      new AIMessage("Zapamatováno."),
    ]);
    const tenant = await tenants.get("a");

    await tenant.graph.invoke({ messages: [new HumanMessage("x")] }, { configurable: ctx("bob", "member") });

    expect((await tenant.memory.list("alice")).map((m) => m.content)).toEqual(["Sleva 5 % pro stálé zákazníky"]);
  });
});
