import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { fileType } from "@osiris/shared";
import { FileError, type FileStore } from "../../files/store.ts";
import type { SiteFile, VitepressClient } from "../../files/vitepress.ts";
import { publishFolder, type SiteTargetStore } from "../../sites/sftp.ts";
import { getRunContext } from "../context.ts";

/** Publishes the project's website (a folder of its files, www/ by default) to a target over SFTP. */
export function publishSiteTool(files: FileStore, targets: SiteTargetStore) {
  return tool(
    async ({ target, dir }, config) => {
      const ctx = getRunContext(config);
      if (ctx.role !== "admin") return "Web firmy může publikovat jen správce projektu.";
      const all = await targets.list();
      const name = target ?? (all.length === 1 ? all[0]!.name : undefined);
      if (!name) return all.length ? `Uveď cíl: ${all.map((t) => t.name).join(", ")}.` : "Firma nemá nastavený žádný cíl publikování (Web → cíle).";
      try {
        const r = await publishFolder(files, { scope: "project" }, dir, targets, name);
        return `Publikováno na ${name}: nahráno ${r.uploaded}, smazáno ${r.deleted}, beze změny ${r.unchanged} souborů.`;
      } catch (err) {
        return `Publikování selhalo: ${(err as Error).message}`;
      }
    },
    {
      name: "publish_site",
      description:
        "Zveřejní web firmy: nahraje složku (obvykle www, musí obsahovat index.html) z firemních souborů přes SFTP na hosting (např. VPS u vas-hosting.cz). Nahrává jen změny. Jen na výslovný pokyn uživatele.",
      schema: z.object({
        target: z.string().max(80).optional().describe("Název cíle publikování; když je jen jeden, není potřeba"),
        dir: z.string().max(512).default("www").describe("Složka s webem, obvykle www"),
      }),
    },
  );
}

/** A site's name, its folder: kebab-case, dots allowed between parts (k6labs.cz). */
export const SITE_NAME = /^[a-z0-9]+([.-][a-z0-9]+)*$/;
export const VITEPRESS_DIR = "vitepress";

export interface SiteBuild {
  dir: string;
  written: number;
  bytes: number;
  deleted: number;
  skipped: string[];
}

const project = { scope: "project" } as const;

/**
 * Builds a VitePress site from the project's `vitepress/<site>/` (`_vitepress/` holds its config and theme, as
 * `.vitepress/` in VitePress) into `www/<site>/`, replacing what was there. The build runs in the shared builder.
 */
export async function buildSite(files: FileStore, vitepress: VitepressClient, site: string): Promise<SiteBuild> {
  const src = `${VITEPRESS_DIR}/${site}`;
  const dst = `www/${site}`;
  const input: SiteFile[] = [];
  for await (const e of files.walk(project, src)) input.push({ path: e.path.slice(src.length + 1), data: (await files.read(project, e.path)).data });
  if (!input.length) throw new FileError("not_found", "errors.files.folderEmpty", { path: src });
  const built = await vitepress.build(input);
  const written = new Set<string>();
  let bytes = 0;
  const skipped: string[] = [];
  for (const f of built) {
    const path = `${dst}/${f.path}`;
    if (!fileType(path)) {
      skipped.push(f.path);
      continue;
    }
    try {
      await files.write(project, path, f.data, { overwrite: true });
    } catch (err) {
      // A file the store can't take (type, name) is left out; anything else (quota) stops the build.
      if (err instanceof FileError && (err.code === "type" || err.code === "invalid")) {
        skipped.push(f.path);
        continue;
      }
      throw err;
    }
    written.add(path);
    bytes += f.data.length;
  }
  let deleted = 0;
  for await (const e of files.walk(project, dst)) {
    if (!written.has(e.path)) {
      await files.delete(project, e.path);
      deleted++;
    }
  }
  return { dir: dst, written: written.size, bytes, deleted, skipped };
}

export const describeBuild = (b: SiteBuild) =>
  [
    `Sestaveno do ${b.dir}: ${b.written} souborů (${Math.max(1, Math.round(b.bytes / 1024))} kB), smazáno ${b.deleted} starých.`,
    b.skipped.length ? `Vynecháno (nepodporovaný typ): ${b.skipped.slice(0, 10).join(", ")}${b.skipped.length > 10 ? "…" : ""}.` : "",
  ]
    .filter(Boolean)
    .join(" ");

/** The default template of a new site: VitePress's default theme, a home page and one more page, in Czech. */
export function defaultTemplate(site: string): Record<string, string> {
  return {
    "index.md": `---
layout: home

hero:
  name: ${site}
  tagline: Krátce, co děláme a pro koho.
  actions:
    - theme: brand
      text: O nás
      link: /o-nas
features:
  - title: Služba
    details: Co pro zákazníky děláme.
  - title: Kvalita
    details: Proč se na nás mohou spolehnout.
  - title: Kontakt
    details: Jak se s námi spojit.
---
`,
    "o-nas.md": `# O nás

Kdo jsme, co umíme a kde nás najdete.
`,
    "_vitepress/config.mjs": `// Nastavení webu: https://vitepress.dev/reference/site-config
export default {
  lang: "cs",
  title: ${JSON.stringify(site)},
  description: "",
  cleanUrls: true,
  themeConfig: {
    nav: [
      { text: "Domů", link: "/" },
      { text: "O nás", link: "/o-nas" },
    ],
    footer: { copyright: "© ${new Date().getFullYear()} ${site.replace(/["\\]/g, "")}" },
  },
};
`,
  };
}

/** The project's VitePress sites: the folders in vitepress/. */
export async function listSites(files: FileStore): Promise<string[]> {
  const entries = await files.list(project, VITEPRESS_DIR).catch((err) => {
    if (err instanceof FileError && err.code === "not_found") return [];
    throw err;
  });
  return entries.filter((e) => e.type === "dir" && SITE_NAME.test(e.name)).map((e) => e.name);
}

/** A new site from the default template; refused when the folder exists. */
export async function createSite(files: FileStore, site: string): Promise<void> {
  if (!SITE_NAME.test(site)) throw new FileError("invalid", "errors.sites.name");
  if ((await listSites(files)).includes(site)) throw new FileError("exists", "errors.sites.exists", { site });
  for (const [path, text] of Object.entries(defaultTemplate(site))) await files.write(project, `${VITEPRESS_DIR}/${site}/${path}`, Buffer.from(text), { overwrite: false });
}

export function buildVitepressTool(files: FileStore, vitepress: VitepressClient) {
  return tool(
    async ({ site }) => {
      try {
        return `${describeBuild(await buildSite(files, vitepress, site))} Zveřejnit jde nástrojem publish_site se složkou www/${site}.`;
      } catch (err) {
        if (err instanceof FileError && err.code === "not_found") return err.message;
        return `Sestavení selhalo: ${(err as Error).message}`;
      }
    },
    {
      name: "build_vitepress_site",
      description:
        "Sestaví web z VitePress šablony ve firemních souborech vitepress/<site>/ (stránky v Markdownu, index.md povinný; konfigurace a téma " +
        "ve vitepress/<site>/_vitepress/, tj. config.js a theme/, místo .vitepress) a uloží hotový web do www/<site>/ (to, co tam bylo, nahradí).",
      schema: z.object({ site: z.string().regex(SITE_NAME, "Název webu: malá písmena, číslice, pomlčky a tečky (např. firma.cz)").max(60).describe("Název webu, složka ve vitepress/") }),
    },
  );
}
