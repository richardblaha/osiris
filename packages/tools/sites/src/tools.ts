import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { FileError, type FileStore } from "@osiris/core/files/store.ts";
import type { VitepressClient } from "@osiris/core/files/vitepress.ts";
import { buildSite, describeBuild, SITE_DIST } from "@osiris/core/sites/site.ts";
import { publishFolder, type SiteTargetStore } from "@osiris/core/sites/sftp.ts";
import { getRunContext } from "@osiris/core/agent/context.ts";

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

/** Builds the project's website with the shared VitePress builder. */
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
