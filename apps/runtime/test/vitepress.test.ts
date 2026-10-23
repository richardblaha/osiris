import { describe, expect, it } from "vitest";
import { buildVitepressTool, srcDirOf } from "@osiris/core/agent/tools/site.ts";
import { VitepressClient } from "@osiris/core/files/vitepress.ts";
import { createTestApp, createTestProjects } from "./helpers.ts";

const project = { scope: "project" } as const;

describe("build_vitepress_site", () => {
  it("sends .vitepress/ and the pages' folder to the builder and replaces .vitepress/dist/ with the result", async () => {
    const { projects } = createTestProjects();
    const acme = await projects.get("acme");
    await acme.files.write(project, ".vitepress/config.mjs", Buffer.from('export default { srcDir: "./web/" }'));
    await acme.files.write(project, "web/index.md", Buffer.from("# Firma"));
    // The project's other files never go to the site.
    await acme.files.write(project, "poznamky.md", Buffer.from("# Interní"));
    await acme.files.write(project, ".vitepress/dist/stara.html", Buffer.from("<p>stará</p>"));
    await acme.files.write(project, ".vitepress/cache/x.json", Buffer.from("{}"));

    let sent: string[] = [];
    const fakeFetch = (async (_url: URL, init: RequestInit) => {
      sent = [...(init.body as FormData).keys()].sort();
      const out = new FormData();
      out.append("index.html", new Blob(["<h1>Firma</h1>"]), "file");
      out.append("assets/app.js", new Blob(["console.log(1)"]), "file");
      out.append("data.bin", new Blob(["x"]), "file");
      return new Response(out);
    }) as typeof fetch;
    const tool = buildVitepressTool(acme.files, new VitepressClient("http://vitepress:3000", fakeFetch));

    const answer = await tool.invoke({});
    expect(sent).toEqual([".vitepress/config.mjs", "web/index.md"]);
    expect(answer).toContain("Sestaveno do .vitepress/dist: 2 souborů");
    expect(answer).toContain("smazáno 1");
    expect(answer).toContain("data.bin");
    expect((await acme.files.read(project, ".vitepress/dist/index.html")).data.toString()).toBe("<h1>Firma</h1>");
    await expect(acme.files.read(project, ".vitepress/dist/stara.html")).rejects.toThrow();
    // .vitepress is the one hidden folder the files reach; the project's own data never.
    expect((await acme.files.list(project)).map((e) => e.name)).toEqual([".vitepress", "web", "poznamky.md"]);
    await expect(acme.files.read(project, ".osiris/project.json")).rejects.toThrow();
  });

  it("reads the pages' folder from the config", () => {
    expect(srcDirOf('export default { srcDir: "web" }')).toBe("web");
    expect(srcDirOf("srcDir: './stranky/'")).toBe("stranky");
    expect(srcDirOf("export default { title: 'x' }")).toBe("");
  });
});

describe("the project's website", () => {
  it("is created once from the template by admins, with its pages apart from the project's files", async () => {
    const { projects } = createTestProjects();
    const app = await createTestApp(projects);
    const as = (who: string) => (path: string, init: RequestInit = {}) =>
      app.request(`/api${path}`, { ...init, headers: { authorization: `Bearer ${who}`, "x-project-id": "acme", "content-type": "application/json" } });
    const admin = as("acme");
    expect(await (await admin("/site")).json()).toEqual({ exists: false, srcDir: null, builder: false });
    expect((await as("bob:project=acme")("/site", { method: "POST", body: JSON.stringify({ title: "Firma" }) })).status).toBe(403);
    expect((await admin("/site", { method: "POST", body: JSON.stringify({ title: "Elektro Novák" }) })).status).toBe(201);
    expect((await admin("/site", { method: "POST", body: JSON.stringify({ title: "Znovu" }) })).status).toBe(409);
    expect(await (await admin("/site")).json()).toEqual({ exists: true, srcDir: "web", builder: false });
    const acme = await projects.get("acme");
    expect((await acme.files.read(project, ".vitepress/config.mjs")).data.toString()).toContain('title: "Elektro Novák"');
    expect((await acme.files.read(project, "web/index.md")).data.toString()).toContain("layout: home");
    // Without a builder there is nothing to build with.
    expect((await admin("/site/build", { method: "POST" })).status).toBe(503);
  });
});
