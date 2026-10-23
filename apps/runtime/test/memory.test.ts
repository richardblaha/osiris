import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import { MemoryStore } from "@osiris/core/agent/memory.ts";
import { createTestDb, createTestProjects } from "./helpers.ts";

const ctx = (user: string, role: "admin" | "member") => ({
  thread_id: `t-${user}`,
  project_id: "a",
  user_id: user,
  role,
  channel: "web" as const,
});

describe("MemoryStore", () => {
  it("shows a user their own and shared memories, not other users' personal ones", async () => {
    const store = new MemoryStore(await createTestDb());
    await store.add("alice", "Alice tyká", "personal");
    await store.add("bob", "Bob vyká", "personal");
    const shared = await store.add("alice", "Firma není plátce DPH", "project");

    expect((await store.list("bob")).map((m) => m.content)).toEqual(["Firma není plátce DPH", "Bob vyká"]);
    expect(await store.delete(shared.id, "personal", "bob")).toBe(false);
    expect(await store.delete(shared.id, "project", "bob")).toBe(true);
  });
});

describe("memory tools", () => {
  it("remembers across threads and injects memories into the prompt", async () => {
    const { projects, model } = createTestProjects([
      new AIMessage({ content: "", tool_calls: [{ id: "m1", name: "remember", args: { content: "Preferuje platbu převodem" } }] }),
      new AIMessage("Zapamatováno."),
      new AIMessage("Převodem."),
    ]);
    const { graph } = await projects.get("a");

    await graph.invoke({ messages: [new HumanMessage("Platím převodem, pamatuj si to")] }, { configurable: ctx("alice", "member") });
    await graph.invoke({ messages: [new HumanMessage("Jak platím?")] }, { configurable: { ...ctx("alice", "member"), thread_id: "t2" } });

    expect(model.calls[2]?.[0]?.text).toMatch(/# PAMĚŤ[\s\S]*Preferuje platbu převodem/);
  });

  it("remembers for the whole project when an admin asks, and for themselves when a member does", async () => {
    const { projects } = createTestProjects([
      new AIMessage({ content: "", tool_calls: [{ id: "m1", name: "remember", args: { content: "Sleva 5 % pro stálé zákazníky" } }] }),
      new AIMessage("Zapamatováno."),
      new AIMessage({ content: "", tool_calls: [{ id: "m2", name: "remember", args: { content: "Bob jezdí autem", scope: "project" } }] }),
      new AIMessage("Nelze."),
      new AIMessage({ content: "", tool_calls: [{ id: "m3", name: "remember", args: { content: "Bob jezdí autem" } }] }),
      new AIMessage("Zapamatováno."),
    ]);
    const project = await projects.get("a");

    await project.graph.invoke({ messages: [new HumanMessage("x")] }, { configurable: ctx("alice", "admin") });
    const refused = await project.graph.invoke({ messages: [new HumanMessage("y")] }, { configurable: ctx("bob", "member") });
    expect(refused.messages.find((m) => m.getType() === "tool")?.text).toMatch(/Firemní paměť mění jen správce/);
    await project.graph.invoke({ messages: [new HumanMessage("z")] }, { configurable: { ...ctx("bob", "member"), thread_id: "t2" } });

    expect((await project.memory.list("carol")).map((m) => m.content)).toEqual(["Sleva 5 % pro stálé zákazníky"]);
    expect((await project.memory.list("bob")).map((m) => [m.content, m.scope])).toEqual([
      ["Bob jezdí autem", "personal"],
      ["Sleva 5 % pro stálé zákazníky", "project"],
    ]);
  });
});
