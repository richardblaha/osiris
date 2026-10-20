import { describe, expect, it } from "vitest";
import { createVitepressApp } from "../src/app.ts";
import { safePath } from "../src/build.ts";

const form = (files: Record<string, string>) => {
  const f = new FormData();
  for (const [path, text] of Object.entries(files)) f.append(path, new Blob([text]), "file");
  return f;
};

describe("the VitePress builder", () => {
  it("builds a site, with _vitepress as its config folder", { timeout: 120_000 }, async () => {
    const app = createVitepressApp();
    const res = await app.request("/build", {
      method: "POST",
      body: form({
        "index.md": "# Elektro Novák\n\nMontáže a revize.",
        "sluzby.md": "# Služby",
        "_vitepress/config.js": "export default { title: 'Elektro Novák', lang: 'cs' }",
      }),
    });
    expect(res.status).toBe(200);
    const out = await res.formData();
    const paths = [...out.keys()];
    expect(paths).toContain("index.html");
    expect(paths).toContain("sluzby.html");
    expect(await (out.get("index.html") as File).text()).toContain("Elektro Novák");
  });

  it("answers a failing build with its log", { timeout: 120_000 }, async () => {
    const res = await createVitepressApp().request("/build", {
      method: "POST",
      body: form({ "index.md": "# Ahoj", "_vitepress/config.js": "export default {" }),
    });
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBeTruthy();
  });

  it("refuses paths outside the site and a site without index.md", async () => {
    expect(safePath("../etc/passwd")).toBeNull();
    expect(safePath(".vitepress/config.js")).toBeNull();
    expect(safePath("a//b")).toBeNull();
    expect(safePath("_vitepress/theme/index.js")).toEqual(["_vitepress", "theme", "index.js"]);
    const res = await createVitepressApp().request("/build", { method: "POST", body: form({ "readme.md": "x" }) });
    expect(await res.json()).toEqual({ error: "Chybí index.md" });
  });
});
