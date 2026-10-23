import { describe, expect, it } from "vitest";
import { buildVitepressTool } from "@osiris/core/agent/tools/site.ts";
import { VitepressClient } from "@osiris/core/files/vitepress.ts";
import { createTestApp, createTestProjects } from "./helpers.ts";

const project = { scope: "project" } as const;

describe("build_vitepress_site", () => {
  it("sends vitepress/<site>/ to the builder and replaces www/<site>/ with the result", async () => {
    const { projects } = createTestProjects();
    const acme = await projects.get("acme");
    await acme.files.write(project, "vitepress/firma/index.md", Buffer.from("# Firma"));
    await acme.files.write(project, "vitepress/firma/_vitepress/config.js", Buffer.from("export default {}"));
    await acme.files.write(project, "www/firma/stara.html", Buffer.from("<p>stará</p>"));
    await acme.files.write(project, "www/jiny/index.html", Buffer.from("<p>jiný web</p>"));

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

    const answer = await tool.invoke({ site: "firma" });
    expect(sent).toEqual(["_vitepress/config.js", "index.md"]);
    expect(answer).toContain("Sestaveno do www/firma: 2 souborů");
    expect(answer).toContain("smazáno 1");
    expect(answer).toContain("data.bin");
    expect((await acme.files.read(project, "www/firma/index.html")).data.toString()).toBe("<h1>Firma</h1>");
    await expect(acme.files.read(project, "www/firma/stara.html")).rejects.toThrow();
    // Other sites stay.
    expect((await acme.files.read(project, "www/jiny/index.html")).data.toString()).toBe("<p>jiný web</p>");

    expect(await tool.invoke({ site: "nic" })).toContain("doesn't exist");
    await expect(tool.invoke({ site: "../www" })).rejects.toThrow();
  });
});

describe("VitePress sites", () => {
  it("are created from the default template, built and removed by admins", async () => {
    const { projects } = createTestProjects();
    const app = await createTestApp(projects);
    const as = (who: string) => (path: string, init: RequestInit = {}) =>
      app.request(`/api${path}`, { ...init, headers: { authorization: `Bearer ${who}`, "x-project-id": "acme", "content-type": "application/json" } });
    const admin = as("acme");
    expect((await as("bob:project=acme")("/vitepress-sites", { method: "POST", body: JSON.stringify({ name: "firma.cz" }) })).status).toBe(403);
    expect((await admin("/vitepress-sites", { method: "POST", body: JSON.stringify({ name: "firma.cz" }) })).status).toBe(201);
    expect((await admin("/vitepress-sites", { method: "POST", body: JSON.stringify({ name: "firma.cz" }) })).status).toBe(409);
    expect((await admin("/vitepress-sites", { method: "POST", body: JSON.stringify({ name: "../x" }) })).status).toBe(400);
    expect(await (await admin("/vitepress-sites")).json()).toEqual({ sites: ["firma.cz"], builder: false });
    const acme = await projects.get("acme");
    const config = (await acme.files.read(project, "vitepress/firma.cz/_vitepress/config.mjs")).data.toString();
    expect(config).toContain('title: "firma.cz"');
    expect((await acme.files.read(project, "vitepress/firma.cz/index.md")).data.toString()).toContain("layout: home");
    // Without a builder there is nothing to build with.
    expect((await admin("/vitepress-sites/firma.cz/build", { method: "POST" })).status).toBe(503);
    await acme.files.write(project, "www/firma.cz/index.html", Buffer.from("<p>x</p>"));
    expect((await admin("/vitepress-sites/firma.cz", { method: "DELETE" })).status).toBe(204);
    expect(await (await admin("/vitepress-sites")).json()).toEqual({ sites: [], builder: false });
    await expect(acme.files.read(project, "www/firma.cz/index.html")).rejects.toThrow();
  });
});
