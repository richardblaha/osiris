import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import { loadSkills, parseSkill } from "@osiris/core/agent/skills.ts";
import { createTestProjects } from "./helpers.ts";

const ctx = { thread_id: "t", project_id: "a", user_id: "u", role: "admin" as const, channel: "web" as const };

function skillsDir(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "osiris-skills-"));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(dir, name));
    writeFileSync(join(dir, name, "SKILL.md"), content);
  }
  return dir;
}

describe("skills", () => {
  it("parses frontmatter and instructions", () => {
    expect(parseSkill('---\nname: faktura\ndescription: "Vystavení faktury"\n---\n\n# Postup\nKrok 1.\n')).toEqual({
      name: "faktura",
      description: "Vystavení faktury",
      instructions: "# Postup\nKrok 1.",
    });
  });

  it("rejects malformed skills", () => {
    expect(() => parseSkill("# bez frontmatteru")).toThrow(/frontmatter/);
    expect(() => parseSkill("---\nname: Faktura\ndescription: x\n---\nobsah")).toThrow(/kebab/);
    expect(() => parseSkill("---\nname: faktura\n---\nobsah")).toThrow(/description/);
  });

  it("loads a directory sorted by name and requires name to match the folder", () => {
    const dir = skillsDir({
      nabidka: "---\nname: nabidka\ndescription: Nabídka\n---\nN",
      faktura: "---\nname: faktura\ndescription: Faktura\n---\nF",
    });
    expect(loadSkills(dir).map((s) => s.name)).toEqual(["faktura", "nabidka"]);
    expect(loadSkills(join(dir, "missing"))).toEqual([]);
    expect(() => loadSkills(skillsDir({ jine: "---\nname: faktura\ndescription: F\n---\nF" }))).toThrow(/match/);
  });

  it("lists skills in the prompt and returns instructions via load_skill", async () => {
    const { projects, model } = createTestProjects(
      [
        new AIMessage({ content: "", tool_calls: [{ id: "s1", name: "load_skill", args: { name: "faktura" } }] }),
        new AIMessage("Hotovo."),
      ],
      [{ name: "faktura", description: "Vystavení faktury", instructions: "Uveď IČO a datum splatnosti." }],
    );
    const { graph } = await projects.get("a");

    const state = await graph.invoke({ messages: [new HumanMessage("Udělej fakturu")] }, { configurable: ctx });

    expect(model.calls[0]?.[0]?.text).toContain("- faktura: Vystavení faktury");
    expect(model.calls[0]?.[0]?.text).not.toContain("IČO");
    const result = state.messages.find((m) => ToolMessage.isInstance(m));
    expect(result?.text).toBe("Uveď IČO a datum splatnosti.");
  });

  it("keeps the bundled skills as a layer below the project's: replaced by a copy, back when the copy is deleted", async () => {
    const bundled = [{ name: "faktura", description: "Obecná", instructions: "Obecný postup.", requires: "database" as const }];
    const { projects } = createTestProjects([], bundled);
    const a = await projects.get("a");
    const b = await projects.get("b");
    // Every project has them, without a copy of its own.
    expect(await a.skills.list()).toEqual([{ name: "faktura", description: "Obecná", source: "bundled", requires: "database" }]);
    expect(await a.skills.projectSkills()).toEqual([]);
    expect((await b.skills.get("faktura"))?.source).toBe("bundled");

    // The project's skill of the same name replaces it there, and only there.
    await a.skills.put({ name: "faktura", description: "Naše", instructions: "Náš postup." });
    await a.skills.put({ name: "revize", description: "Revize elektro", instructions: "Postup revize." });
    expect((await a.skills.get("faktura"))?.instructions).toBe("Náš postup.");
    expect((await b.skills.get("faktura"))?.instructions).toBe("Obecný postup.");
    expect((await a.skills.get("faktura", "", "bundled"))?.instructions).toBe("Obecný postup.");

    // A user's own skill wins over the project's, for them alone.
    await a.skills.put({ name: "faktura", description: "Moje", instructions: "Můj postup." }, "personal", "bob");
    expect((await a.skills.list("bob")).filter((s) => s.name === "faktura").map((s) => [s.source, !!s.overridden])).toEqual([
      ["personal", false],
      ["project", true],
      ["bundled", true],
    ]);
    expect((await a.skills.get("faktura", "bob"))?.instructions).toBe("Můj postup.");
    expect((await a.skills.get("faktura", "carol"))?.instructions).toBe("Náš postup.");
    expect((await a.skills.get("faktura", "bob", "project"))?.instructions).toBe("Náš postup.");

    // Deleting the project's copy brings the bundled one back; the bundled one itself can't be deleted.
    expect(await a.skills.delete("faktura")).toBe(true);
    expect((await a.skills.get("faktura"))?.instructions).toBe("Obecný postup.");
    expect(await a.skills.delete("faktura")).toBe(false);
    expect((await a.skills.get("faktura"))?.source).toBe("bundled");
  });

  it("saves a skill with save_skill: an admin's for the project, a member's for themselves", async () => {
    const { projects } = createTestProjects([
      new AIMessage({ content: "", tool_calls: [{ id: "s1", name: "save_skill", args: { name: "nabidka", description: "Cenová nabídka", instructions: "1. Zjisti rozsah." } }] }),
      new AIMessage("Uloženo."),
      new AIMessage({ content: "", tool_calls: [{ id: "s2", name: "save_skill", args: { name: "nabidka", description: "Moje", instructions: "Můj postup.", scope: "project" } }] }),
      new AIMessage("Nejde."),
      new AIMessage({ content: "", tool_calls: [{ id: "s3", name: "save_skill", args: { name: "nabidka", description: "Moje", instructions: "Můj postup." } }] }),
      new AIMessage("Uloženo."),
    ]);
    const a = await projects.get("a");
    await a.graph.invoke({ messages: [new HumanMessage("Ulož")] }, { configurable: { ...ctx, user_id: "admin", role: "admin" } });
    expect((await a.skills.get("nabidka"))?.source).toBe("project");

    const member = { ...ctx, thread_id: "t2", user_id: "bob", role: "member" as const };
    const refused = await a.graph.invoke({ messages: [new HumanMessage("Ulož")] }, { configurable: member });
    expect(refused.messages.find((m) => ToolMessage.isInstance(m))?.text).toMatch(/jen správce/);
    await a.graph.invoke({ messages: [new HumanMessage("Ulož")] }, { configurable: { ...member, thread_id: "t3" } });
    expect((await a.skills.get("nabidka", "bob"))?.instructions).toBe("Můj postup.");
    expect((await a.skills.get("nabidka", "carol"))?.instructions).toBe("1. Zjisti rozsah.");
  });

  it("omits the skills section when there are none", async () => {
    const { projects, model } = createTestProjects([new AIMessage("Ahoj")]);
    const { graph } = await projects.get("a");
    await graph.invoke({ messages: [new HumanMessage("ahoj")] }, { configurable: ctx });
    expect(model.calls[0]?.[0]?.text).not.toContain("DOVEDNOSTI");
  });

  it("ships valid bundled skills", () => {
    // An invalid skill throws, which would stop the runtime from starting.
    expect(() => loadSkills(join(import.meta.dirname, "../skills"))).not.toThrow();
  });
});

describe("bundled skills", () => {
  it("are only skill-creator, offered whenever the project has skills", async () => {
    const bundled = loadSkills(join(import.meta.dirname, "..", "skills"));
    expect(bundled.map((s) => s.name)).toEqual(["skill-creator"]);
    expect(bundled[0]!.requires).toBeUndefined();

    const { projects, model } = createTestProjects([new AIMessage("Ahoj"), new AIMessage("Ahoj")], bundled);
    const a = await projects.get("a");
    const ctx = { thread_id: "t", project_id: "a", user_id: "u", role: "member" as const, channel: "web" as const };
    await a.graph.invoke({ messages: [new HumanMessage("Ahoj")] }, { configurable: ctx });
    expect(model.calls[0]?.[0]?.text).toMatch(/- skill-creator: /);
    await a.features.set({ skills: false });
    await a.graph.invoke({ messages: [new HumanMessage("Ahoj")] }, { configurable: { ...ctx, thread_id: "t2" } });
    expect(model.calls[1]?.[0]?.text).not.toMatch(/skill-creator/);
  });
});
