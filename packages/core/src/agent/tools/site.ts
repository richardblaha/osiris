import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { fileType } from "@osiris/shared";
import { FileError, type FileStore } from "../../files/store.ts";
import type { SiteFile, VitepressClient } from "../../files/vitepress.ts";
import { publishFolder, type SiteTargetStore } from "../../sites/sftp.ts";
import { getRunContext } from "../context.ts";

/** Publishes the tenant's website (a folder of its files, www/ by default) to a target over SFTP. */
export function publishSiteTool(files: FileStore, targets: SiteTargetStore) {
  return tool(
    async ({ target, dir }, config) => {
      const ctx = getRunContext(config);
      if (ctx.role !== "admin") return "Web firmy může publikovat jen správce tenanta.";
      const all = await targets.list();
      const name = target ?? (all.length === 1 ? all[0]!.name : undefined);
      if (!name) return all.length ? `Uveď cíl: ${all.map((t) => t.name).join(", ")}.` : "Firma nemá nastavený žádný cíl publikování (Web → cíle).";
      try {
        const r = await publishFolder(files, { scope: "tenant" }, dir, targets, name);
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
const SITE_NAME = /^[a-z0-9]+([.-][a-z0-9]+)*$/;

/**
 * Builds a VitePress site from the tenant's `vitepress/<site>/` (`_vitepress/` holds its config and theme, as
 * `.vitepress/` in VitePress) into `www/<site>/`, replacing what was there. The build runs in the shared builder.
 */
export function buildVitepressTool(files: FileStore, vitepress: VitepressClient) {
  const tenant = { scope: "tenant" } as const;
  return tool(
    async ({ site }) => {
      const src = `vitepress/${site}`;
      const dst = `www/${site}`;
      try {
        const input: SiteFile[] = [];
        for await (const e of files.walk(tenant, src)) input.push({ path: e.path.slice(src.length + 1), data: (await files.read(tenant, e.path)).data });
        if (!input.length) return `Složka ${src} neexistuje nebo je prázdná.`;
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
            await files.write(tenant, path, f.data, { overwrite: true });
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
        for await (const e of files.walk(tenant, dst)) {
          if (!written.has(e.path)) {
            await files.delete(tenant, e.path);
            deleted++;
          }
        }
        return [
          `Sestaveno do ${dst}: ${written.size} souborů (${Math.max(1, Math.round(bytes / 1024))} kB), smazáno ${deleted} starých.`,
          skipped.length ? `Vynecháno (nepodporovaný typ): ${skipped.slice(0, 10).join(", ")}${skipped.length > 10 ? "…" : ""}.` : "",
          `Zveřejnit jde nástrojem publish_site se složkou ${dst}.`,
        ]
          .filter(Boolean)
          .join(" ");
      } catch (err) {
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
