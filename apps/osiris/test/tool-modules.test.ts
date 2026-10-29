import { describe, expect, it } from "vitest";
import { loadToolModules, TOOL_MODULE_NAMES } from "../src/tool-modules.ts";
import { createTestProjects } from "./helpers.ts";

describe("tool modules", () => {
  it("loads every module for 'all', but images, the scheduler and the infrastructure only with their settings", async () => {
    const names = (await loadToolModules({ enabled: ["all"] })).map((m) => m.name);
    expect(names).toEqual(TOOL_MODULE_NAMES.filter((n) => n !== "images" && n !== "scheduler" && n !== "infrastructure"));
    const withOps = (await loadToolModules({ enabled: ["all"], infrastructure: { projects: ["twin"], ops: { url: "http://t", token: async () => "" } } })).map((m) => m.name);
    expect(withOps).toContain("infrastructure");
  });

  it("loads only the modules named", async () => {
    const modules = await loadToolModules({ enabled: ["files", "http"] });
    expect(modules.map((m) => m.name)).toEqual(["files", "http"]);
  });

  it("refuses an unknown module", async () => {
    await expect(loadToolModules({ enabled: ["files", "fax"] })).rejects.toThrow(/fax/);
  });

  it("a project has no tools of a module left out", async () => {
    const { projects } = createTestProjects([], [], undefined, { enabled: ["knowledge"] });
    const acme = await projects.get("acme");
    const names = acme.builtinTools.map(([, t]) => t.name);
    expect(names).toEqual(["search_knowledge", "save_knowledge"]);
    expect(acme.builtinTools.every(([f]) => f === "knowledge")).toBe(true);
  });
});
