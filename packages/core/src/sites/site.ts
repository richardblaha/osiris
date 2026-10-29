import { fileType } from "@osiris/shared";
import { FileError, type FileStore } from "../files/store.ts";
import type { SiteFile, VitepressClient } from "../files/vitepress.ts";

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
