import { describe, expect, it } from "vitest";
import { mergePersonalIntoTenant } from "@osiris/core/files/sync.ts";
import type { FileLocation } from "@osiris/core/files/store.ts";
import { createTestTenants } from "./helpers.ts";

describe("moving personal settings to the tenant", () => {
  it("moves files, skills, secrets and memories, renaming what's taken, and changes nothing the second time", async () => {
    const { tenants } = createTestTenants();
    const t = await tenants.get("acme");
    const alice: FileLocation = { scope: "personal", userId: "alice" };
    const skill = (name: string) => Buffer.from(`---\nname: ${name}\ndescription: d\n---\nPostup ${name}`);
    await t.files.write({ scope: "tenant" }, "knowledge/cenik.md", Buffer.from("firma"));
    await t.files.write({ scope: "tenant" }, "skills/nabidka/SKILL.md", skill("nabidka"));
    await t.files.write(alice, "knowledge/cenik.md", Buffer.from("alice"));
    await t.files.write(alice, "poznamky.txt", Buffer.from("x"));
    await t.files.write(alice, "skills/nabidka/SKILL.md", skill("nabidka"));
    await t.secrets.put("CRM", "", { value: "a", allowedHosts: ["crm.example.com"], description: "" });
    await t.secrets.put("CRM", "alice", { value: "b", allowedHosts: ["crm.example.com"], description: "" });
    await t.memory.add("alice", "Alice má ráda kávu", "personal");

    await mergePersonalIntoTenant(t.db, t.files);
    await mergePersonalIntoTenant(t.db, t.files);

    const read = async (p: string) => (await t.files.read({ scope: "tenant" }, p)).data.toString();
    expect(await read("knowledge/cenik.md")).toBe("firma");
    expect(await read("knowledge/cenik-2.md")).toBe("alice");
    expect(await read("poznamky.txt")).toBe("x");
    expect((await t.skills.get("nabidka-2"))?.instructions).toContain("Postup nabidka");
    for await (const left of t.files.walk(alice)) expect.unreachable(left.path);
    expect((await t.secrets.list("bob")).map((s) => s.name)).toEqual(["CRM", "CRM_2"]);
    expect((await t.memory.list("bob")).map((m) => m.content)).toEqual(["Alice má ráda kávu"]);
  });
});
