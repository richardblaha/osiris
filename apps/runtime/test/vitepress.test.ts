import { describe, expect, it } from "vitest";
import { buildVitepressTool } from "@osiris/core/agent/tools/site.ts";
import { VitepressClient } from "@osiris/core/files/vitepress.ts";
import { createTestTenants } from "./helpers.ts";

const tenant = { scope: "tenant" } as const;

describe("build_vitepress_site", () => {
  it("sends vitepress/<site>/ to the builder and replaces www/<site>/ with the result", async () => {
    const { tenants } = createTestTenants();
    const acme = await tenants.get("acme");
    await acme.files.write(tenant, "vitepress/firma/index.md", Buffer.from("# Firma"));
    await acme.files.write(tenant, "vitepress/firma/_vitepress/config.js", Buffer.from("export default {}"));
    await acme.files.write(tenant, "www/firma/stara.html", Buffer.from("<p>stará</p>"));
    await acme.files.write(tenant, "www/jiny/index.html", Buffer.from("<p>jiný web</p>"));

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
    expect((await acme.files.read(tenant, "www/firma/index.html")).data.toString()).toBe("<h1>Firma</h1>");
    await expect(acme.files.read(tenant, "www/firma/stara.html")).rejects.toThrow();
    // Other sites stay.
    expect((await acme.files.read(tenant, "www/jiny/index.html")).data.toString()).toBe("<p>jiný web</p>");

    expect(await tool.invoke({ site: "nic" })).toContain("neexistuje");
    await expect(tool.invoke({ site: "../www" })).rejects.toThrow();
  });
});
