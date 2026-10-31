import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import { createTestProjects } from "./helpers.ts";

const ctx = (user: string, role: "admin" | "member") => ({
  thread_id: `t-${user}`,
  project_id: "a",
  user_id: user,
  role,
  channel: "web" as const,
});

describe("MemoryStore", () => {
  it("shows a user their own and shared memories, not other users' personal ones", async () => {
    const store = (await createTestProjects().projects.get("m")).memory;
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

describe("memory through Mem0", () => {
  it("keeps each memory as a file, links entities, and finds them again from the files after the cache is gone", async () => {
    const { projects } = createTestProjects();
    const project = await projects.get("m");
    const novak = await project.memory.add("alice", "Pan Novák platí převodem", "personal");
    await project.memory.add("alice", "Pan Novák bydlí v Brně", "personal");
    await project.memory.add("", "Firma nepracuje o víkendu", "project");

    const own = (await project.records.walk("private/users")).filter((p) => p.endsWith(".md"));
    expect(own.filter((p) => p.includes("/memory/") && !p.includes("/entities/"))).toHaveLength(2);
    expect(await project.records.readText(`private/users/${own.find((p) => p.endsWith(`/memory/${novak.id}.md`))}`)).toContain("Pan Novák platí převodem");
    expect((await project.records.list("memory")).filter((n) => n.endsWith(".md"))).toHaveLength(1);
    // An entity (Mem0's heuristics cut Czech words at diacritics: "Nov") links both of Alice's memories.
    const entities = own.filter((p) => p.includes("/memory/entities/"));
    const linked = await Promise.all(entities.map(async (p) => (await project.records.readText(`private/users/${p}`))!));
    expect(linked.some((t) => t.includes("Nov") && (JSON.parse(t.split("\n")[1]!) as { linkedMemoryIds: string[] }).linkedMemoryIds.length === 2)).toBe(true);

    await project.cache.batch(["DELETE FROM mem0_points", "DELETE FROM mem0_text"], "write");
    await project.init();
    expect((await project.memory.search("alice", "Novák převodem")).map((m) => m.content)).toContain("Pan Novák platí převodem");
    expect((await project.memory.list("alice")).map((m) => m.content).sort()).toEqual(["Firma nepracuje o víkendu", "Pan Novák bydlí v Brně", "Pan Novák platí převodem"]);
  });
});
