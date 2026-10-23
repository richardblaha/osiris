import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import { loadSkills, parseSkill } from "@osiris/core/agent/skills.ts";
import { createTestTenants } from "./helpers.ts";

const ctx = { thread_id: "t", tenant_id: "a", user_id: "u", role: "admin" as const, channel: "web" as const };

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
    const { tenants, model } = createTestTenants(
      [
        new AIMessage({ content: "", tool_calls: [{ id: "s1", name: "load_skill", args: { name: "faktura" } }] }),
        new AIMessage("Hotovo."),
      ],
      [{ name: "faktura", description: "Vystavení faktury", instructions: "Uveď IČO a datum splatnosti." }],
    );
    const { graph } = await tenants.get("a");

    const state = await graph.invoke({ messages: [new HumanMessage("Udělej fakturu")] }, { configurable: ctx });

    expect(model.calls[0]?.[0]?.text).toContain("- faktura: Vystavení faktury");
    expect(model.calls[0]?.[0]?.text).not.toContain("IČO");
    const result = state.messages.find((m) => ToolMessage.isInstance(m));
    expect(result?.text).toBe("Uveď IČO a datum splatnosti.");
  });

  it("puts the tenant's skills over bundled ones of the same name, per tenant", async () => {
    const bundled = [{ name: "faktura", description: "Obecná", instructions: "Obecný postup." }];
    const { tenants } = createTestTenants([], bundled);
    const a = await tenants.get("a");
    const b = await tenants.get("b");

    await a.skills.put({ name: "faktura", description: "Naše", instructions: "Náš postup." });
    await a.skills.put({ name: "revize", description: "Revize elektro", instructions: "Postup revize." });
    expect(await a.skills.list()).toEqual([
      { name: "faktura", description: "Naše", source: "tenant" },
      { name: "faktura", description: "Obecná", source: "bundled", overridden: true },
      { name: "revize", description: "Revize elektro", source: "tenant" },
    ]);
    expect(await b.skills.list()).toEqual([{ name: "faktura", description: "Obecná", source: "bundled" }]);

    // A user's own skill wins over the tenant's, for them alone.
    await a.skills.put({ name: "faktura", description: "Moje", instructions: "Můj postup." }, "personal", "bob");
    expect((await a.skills.list("bob")).filter((s) => s.name === "faktura").map((s) => [s.source, !!s.overridden])).toEqual([
      ["personal", false],
      ["tenant", true],
      ["bundled", true],
    ]);
    expect((await a.skills.get("faktura", "bob"))?.instructions).toBe("Můj postup.");
    expect((await a.skills.get("faktura", "carol"))?.instructions).toBe("Náš postup.");
    expect((await a.skills.get("faktura", "bob", "tenant"))?.instructions).toBe("Náš postup.");

    // Deleting the tenant's replacement reveals the bundled skill.
    expect(await a.skills.delete("faktura")).toBe(true);
    expect((await a.skills.get("faktura"))?.instructions).toBe("Obecný postup.");
    expect(await a.skills.delete("faktura")).toBe(false);
  });

  it("omits the skills section when there are none", async () => {
    const { tenants, model } = createTestTenants([new AIMessage("Ahoj")]);
    const { graph } = await tenants.get("a");
    await graph.invoke({ messages: [new HumanMessage("ahoj")] }, { configurable: ctx });
    expect(model.calls[0]?.[0]?.text).not.toContain("DOVEDNOSTI");
  });

  it("ships valid bundled skills", () => {
    // An invalid skill throws, which would stop the runtime from starting.
    expect(() => loadSkills(join(import.meta.dirname, "../skills"))).not.toThrow();
  });
});

describe("bundled skills", () => {
  it("load, and those needing a feature are offered only while it's on", async () => {
    const bundled = loadSkills(join(import.meta.dirname, "..", "skills"));
    expect(bundled.filter((s) => s.requires === "database").map((s) => s.name)).toEqual(["crm", "kontakty"]);

    const { tenants, model } = createTestTenants([new AIMessage("Ahoj"), new AIMessage("Ahoj")], bundled);
    const a = await tenants.get("a");
    const ctx = { thread_id: "t", tenant_id: "a", user_id: "u", role: "member" as const, channel: "web" as const };
    await a.graph.invoke({ messages: [new HumanMessage("Ahoj")] }, { configurable: ctx });
    expect(model.calls[0]?.[0]?.text).toMatch(/- kontakty: /);
    await a.features.set({ database: false });
    await a.graph.invoke({ messages: [new HumanMessage("Ahoj")] }, { configurable: { ...ctx, thread_id: "t2" } });
    expect(model.calls[1]?.[0]?.text).not.toMatch(/kontakty|# DATABÁZE/);
  });
});
