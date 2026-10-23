import { tool, type StructuredToolInterface, type ToolRunnableConfig } from "@langchain/core/tools";
import { z } from "zod";
import { getRunContext, scratchThread } from "../context.ts";
import { ImageService, imageRequest } from "../../images/service.ts";
import type { FileStore } from "../../files/store.ts";
import { assembleSprites, inspectImage, compareImages, edgeContinuity, borderImageMetadata } from "../../images/processing.ts";
import { imageFile, padding } from "../../images/types.ts";
import { imageError } from "../../images/errors.ts";
import { randomUUID } from "node:crypto";

export function imageTools(service: ImageService, files: FileStore): StructuredToolInterface[] {
  const generate = (name: string, operation: "generate" | "edit" | "variations") => tool(async (input, config) => {
    const callId = (config as ToolRunnableConfig).toolCall?.id;
    if (!callId) return JSON.stringify({ error: "TOOL_CALL_ID_REQUIRED" });
    return safe(() => service.generate(imageRequest.parse({ ...input, operation: name === "image_generate" || (name === "image_edit" && input.operation !== "generate") ? input.operation : operation }), config, callId));
  }, { name, description: `${operation === "generate" ? "Vytvoří" : operation === "edit" ? "Upraví" : "Vytvoří variantu"} obrázek pomocí Comfy Cloud. Stačí přirozené zadání. Úpravy bez sourceRevision používají poslední výsledek této konverzace; reference mají explicitní role. Vrací id úlohy, později použij image_get_status. Nevytvářej znovu nejistou úlohu. Výsledné soubory nabídni přes send_chat_file. Nepodporované požadavky neslibuj.`, schema: imageRequest });
  const safe = async (action: () => Promise<unknown>) => {
    try { return JSON.stringify(await action()); }
    catch (error) { const e = imageError(error); return JSON.stringify({ error: e.code, recoverable: e.recoverable, hint: "Check connection and poll the existing job; do not repeat a paid submission." }); }
  };
  return [
    tool(({ url }, config) => safe(() => service.importImage(url, config)), { name: "image_import", description: "Importuje obrázek z URL výslovně zadané nebo schválené uživatelem do souborů této konverzace. Host musí být v administrátorském seznamu povolených domén; neobchází přihlášení ani nestahuje soukromé adresy.", schema: z.object({ url: z.string().url().max(8000) }) }),
    tool(() => safe(() => service.capabilities()), { name: "image_capabilities", description: "Zjistí dostupné Comfy MCP nástroje. Schopnosti modelů zůstávají neznámé, dokud je neověří konkrétní šablona.", schema: z.object({}) }),
    generate("image_generate", "generate"), generate("image_edit", "edit"), generate("image_variations", "variations"),
    tool((input, config) => {
      const callId = (config as ToolRunnableConfig).toolCall?.id;
      if (!callId) return JSON.stringify({ error: "TOOL_CALL_ID_REQUIRED" });
      const frames = input.game?.frames.length ? input.game.frames : input.game?.states;
      if (!input.game || !frames?.length) return JSON.stringify({ error: "SPRITE_FRAME_NAMES_REQUIRED" });
      return safe(() => service.generate(imageRequest.parse({ ...input, game: { ...input.game, kind: "spritesheet" }, output: { ...input.output, count: frames.length } }), config, callId));
    }, { name: "image_generate_spritesheet", description: "Vytvoří konzistentní herní snímky nebo UI stavy a sestaví PNG spritesheet s atlasem. Zadej game.frames nebo game.states a rozměry buněk. Celá tvorba podléhá stejným limitům a obnově úlohy.", schema: imageRequest }),
    tool(({ id }, config) => safe(() => service.status(id, config)), { name: "image_get_status", description: "Zjistí skutečný stav obrazové úlohy a uloží hotové obrázky do souborů konverzace. Běžně nespouští nové generování; volitelná oprava nevyhovujícího výsledku je omezena administrátorským rozpočtem a počtem pokusů.", schema: z.object({ id: z.string().max(100) }) }),
    tool(({ id }, config) => safe(() => service.status(id, config, true)), { name: "image_cancel", description: "Požádá Comfy Cloud o zrušení obrazové úlohy. Zrušení potvrdí jen pokud ho potvrdí poskytovatel.", schema: z.object({ id: z.string().max(100) }) }),
    tool(({ id, index }, config) => safe(() => service.select(getRunContext(config), id, index)), { name: "image_select_revision", description: "Vybere existující verzi a variantu obrázku pro další úpravy v této konverzaci. Předchozí verze zachová.", schema: z.object({ id: z.string().max(100), index: z.number().int().min(0).max(63).default(0) }) }),
    tool((_, config) => safe(() => service.history(getRunContext(config))), { name: "image_get_history", description: "Vrátí revize a výsledky obrázků v této konverzaci pro výběr původní nebo předchozí verze.", schema: z.object({}) }),
    tool(({ path, scope, compareTo, mask, seamless, borderSlices, question }, config) => safe(async () => {
      const ctx = getRunContext(config);
      const { data } = await files.read(scope === "temp" ? { scope, threadId: scratchThread(ctx) } : { scope }, path);
      const metadata = await inspectImage(data);
      const source = compareTo ? (await files.read(compareTo.scope === "temp" ? { scope: "temp", threadId: scratchThread(ctx) } : { scope: "project" }, compareTo.path)).data : undefined;
      const maskData = mask ? (await files.read(mask.scope === "temp" ? { scope: "temp", threadId: scratchThread(ctx) } : { scope: "project" }, mask.path)).data : undefined;
      return { ...metadata, ...(question ? { visual: await service.analyzeVisual({ path, scope }, question, config) } : {}), ...(source ? { comparison: await compareImages(source, data, maskData) } : {}), ...(seamless ? { edges: await edgeContinuity(data) } : {}), ...(borderSlices ? { borderImage: borderImageMetadata(metadata.width, metadata.height, borderSlices) } : {}) };
    }), { name: "image_analyze", description: "Ověří rozměry, formát, integritu a skutečnou průhlednost obrázku. S argumentem question také vizuálně prozkoumá obrázek existujícím modelem; nalezené souřadnice jsou přibližné.", schema: imageFile.extend({ compareTo: imageFile.optional(), mask: imageFile.optional(), seamless: z.boolean().default(false), borderSlices: padding.optional(), question: z.string().max(2000).optional() }) }),
    tool(({ paths, columns, cellWidth, cellHeight, gap }, config) => safe(async () => {
      const ctx = getRunContext(config), loc = { scope: "temp" as const, threadId: scratchThread(ctx) };
      const images: Buffer[] = []; let bytes = 0;
      for (const path of paths) { const { data } = await files.read(loc, path); bytes += data.length; if (bytes > 64 * 1024 * 1024) throw new Error("CONTACT_SHEET_INPUT_TOO_LARGE"); images.push(data); }
      const sheet = await assembleSprites(images, columns, cellWidth, cellHeight, gap);
      const path = `images/${randomUUID()}/contact.png`;
      await files.write(loc, path, sheet.data, { overwrite: false });
      return { artifacts: [{ scope: "temp", path, mime: "image/png" }] };
    }), { name: "image_contact_sheet", description: "Sestaví existující obrázky této konverzace do náhledové mřížky s přesným rozestupem. Neprovádí placené generování.", schema: z.object({ paths: z.array(z.string().max(512)).min(1).max(64), columns: z.number().int().min(1).max(16).default(4), cellWidth: z.number().int().min(1).max(1024).default(256), cellHeight: z.number().int().min(1).max(1024).default(256), gap: z.number().int().min(0).max(128).default(8) }) }),
    tool(({ paths, columns, cellWidth, cellHeight, gap }, config) => safe(async () => {
      const ctx = getRunContext(config);
      const loc = { scope: "temp" as const, threadId: scratchThread(ctx) };
      const images: Buffer[] = []; let bytes = 0;
      for (const path of paths) { const { data } = await files.read(loc, path); bytes += data.length; if (bytes > 64 * 1024 * 1024) throw new Error("SPRITE_INPUT_TOO_LARGE"); images.push(data); }
      const { data, atlas } = await assembleSprites(images, columns, cellWidth, cellHeight, gap);
      const dir = `images/${randomUUID()}`;
      await files.write(loc, `${dir}/sprites.png`, data, { overwrite: false });
      await files.write(loc, `${dir}/atlas.json`, Buffer.from(JSON.stringify(atlas)), { overwrite: false });
      return { artifacts: [{ scope: "temp", path: `${dir}/sprites.png`, mime: "image/png" }, { scope: "temp", path: `${dir}/atlas.json`, mime: "application/json" }], atlas };
    }), { name: "image_assemble_spritesheet", description: "Sestaví existující obrázky této konverzace do přesné mřížky PNG s průhledným pozadím a atlasem JSON. Negeneruje nové snímky ani neslibuje průhlednost uvnitř původních obrázků.", schema: z.object({ paths: z.array(z.string().max(512)).min(1).max(64), columns: z.number().int().min(1).max(16), cellWidth: z.number().int().min(1).max(2048), cellHeight: z.number().int().min(1).max(2048), gap: z.number().int().min(0).max(128).default(0) }) }),
  ];
}
