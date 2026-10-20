import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { FileStore } from "../../files/store.ts";
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
