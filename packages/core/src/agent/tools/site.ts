import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { fileType } from "@osiris/shared";
import { FileError, type FileStore } from "../../files/store.ts";
import type { SiteFile, VitepressClient } from "../../files/vitepress.ts";
import { publishFolder, type SiteTargetStore } from "../../sites/sftp.ts";
import { getRunContext } from "../context.ts";

/** Publishes the project's website (its build, or another folder of its files) to one target over SFTP, or to all. */
export function publishSiteTool(files: FileStore, targets: SiteTargetStore) {
  return tool(
    async ({ target, dir }, config) => {
      const ctx = getRunContext(config);
      if (ctx.role !== "admin") return "Web firmy může publikovat jen správce projektu.";
      const all = (await targets.list()).map((t) => t.name);
      if (!all.length) return "Firma nemá nastavený žádný cíl publikování (Web → cíle).";
      if (target && !all.includes(target)) return `Cíl ${target} neexistuje. Cíle: ${all.join(", ")}.`;
      const lines: string[] = [];
      for (const name of target ? [target] : all) {
        try {
          const r = await publishFolder(files, { scope: "project" }, dir, targets, name);
          lines.push(`${name}: nahráno ${r.uploaded}, smazáno ${r.deleted}, beze změny ${r.unchanged} souborů.`);
        } catch (err) {
          lines.push(`${name}: publikování selhalo: ${(err as Error).message}`);
        }
      }
      return `Publikováno:\n${lines.join("\n")}`;
    },
    {
      name: "publish_site",
      description:
        "Zveřejní web projektu: nahraje sestavený web (.vitepress/dist, musí obsahovat index.html) přes SFTP na hosting, na zadaný cíl, nebo bez cíle na všechny. Nahrává jen změny. Jen na výslovný pokyn uživatele.",
      schema: z.object({
        target: z.string().max(80).optional().describe("Název cíle publikování; bez něj na všechny cíle"),
        dir: z.string().max(512).default(SITE_DIST).describe("Složka s webem, obvykle .vitepress/dist"),
      }),
    },
  );
}

/** The project's one website is a standard VitePress project in its root: `.vitepress/` with the config and theme. */
export const SITE_CONFIG_DIR = ".vitepress";
/** Where a build goes (VitePress's default), published from there. */
export const SITE_DIST = ".vitepress/dist";
/** Pages of a new site: their own folder, so the project's other Markdown files never become public pages. */
export const SITE_SRC = "web";

export interface SiteBuild {
  dir: string;
  written: number;
  bytes: number;
  deleted: number;
  skipped: string[];
}

const project = { scope: "project" } as const;
const CONFIGS = ["config.mts", "config.ts", "config.mjs", "config.js"];

/** The site's config file, or undefined when the project has no website yet. */
async function configOf(files: FileStore): Promise<{ path: string; text: string } | undefined> {
  for (const name of CONFIGS) {
    const path = `${SITE_CONFIG_DIR}/${name}`;
    const found = await files.read(project, path).catch(() => undefined);
    if (found) return { path, text: found.data.toString("utf8") };
  }
  return undefined;
}

/** The pages' folder the config names (`srcDir`), '' for the project's root. */
export const srcDirOf = (config: string) => (/\bsrcDir\s*:\s*["'`](?:\.\/)?([^"'`]*?)\/?["'`]/.exec(config)?.[1] ?? "").replace(/^\.$/, "");

/** Whether the project has a website, and where its pages are. */
export async function siteInfo(files: FileStore): Promise<{ exists: boolean; srcDir: string | null }> {
  const config = await configOf(files);
  return { exists: !!config, srcDir: config ? srcDirOf(config.text) : null };
}

/**
 * Builds the project's website: `.vitepress/` (without its own `dist/` and `cache/`) and the pages' folder (`srcDir`,
 * else every file of the project) go to the shared builder, and the result replaces `.vitepress/dist/`.
 */
export async function buildSite(files: FileStore, vitepress: VitepressClient): Promise<SiteBuild> {
  const config = await configOf(files);
  if (!config) throw new FileError("not_found", "errors.sites.missing");
  const srcDir = srcDirOf(config.text);
  const input: SiteFile[] = [];
  const add = async (dir: string) => {
    for await (const e of files.walk(project, dir)) {
      if (e.path.startsWith(`${SITE_DIST}/`) || e.path.startsWith(`${SITE_CONFIG_DIR}/cache/`)) continue;
      input.push({ path: e.path, data: (await files.read(project, e.path)).data });
    }
  };
  await add(SITE_CONFIG_DIR);
  if (srcDir) await add(srcDir);
  else for (const e of await files.list(project)) if (e.name !== SITE_CONFIG_DIR) await add(e.path);
  const built = await vitepress.build(input);
  const dst = SITE_DIST;
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

/** The template of a new site: VitePress's default theme, a home page and one more page in `web/`, in Czech. */
export function defaultTemplate(site: string): Record<string, string> {
  return {
    [`${SITE_SRC}/index.md`]: `---
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
    [`${SITE_SRC}/o-nas.md`]: `# O nás

Kdo jsme, co umíme a kde nás najdete.
`,
    [`${SITE_CONFIG_DIR}/config.mjs`]: `// Nastavení webu: https://vitepress.dev/reference/site-config
export default {
  // Stránky webu jsou jen ve složce ${SITE_SRC}/: ostatní soubory projektu se nezveřejní.
  srcDir: "${SITE_SRC}",
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

/** The project's website from the template; refused when it has one. */
export async function createSite(files: FileStore, title: string): Promise<void> {
  if (await configOf(files)) throw new FileError("exists", "errors.sites.exists");
  for (const [path, text] of Object.entries(defaultTemplate(title))) await files.write(project, path, Buffer.from(text), { overwrite: false });
}

export function buildVitepressTool(files: FileStore, vitepress: VitepressClient) {
  return tool(
    async () => {
      try {
        return `${describeBuild(await buildSite(files, vitepress))} Zveřejnit jde nástrojem publish_site.`;
      } catch (err) {
        if (err instanceof FileError && err.code === "not_found") return err.message;
        return `Sestavení selhalo: ${(err as Error).message}`;
      }
    },
    {
      name: "build_vitepress_site",
      description:
        "Sestaví web projektu: standardní VitePress v kořeni projektu (konfigurace a téma v .vitepress/, stránky v Markdownu ve složce ze srcDir, obvykle web/) " +
        "a uloží hotový web do .vitepress/dist/ (to, co tam bylo, nahradí).",
      schema: z.object({}),
    },
  );
}
