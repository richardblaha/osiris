import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { fileType } from "@osiris/shared";
import type { FileStore } from "../../files/store.ts";
import { getRunContext, scratchThread } from "../context.ts";
import { isGuardPath } from "../guards.ts";

export function chatFileTool(files: FileStore) {
  return tool(async ({ scope, path }, config) => {
    const ctx = getRunContext(config);
    if (isGuardPath(path)) throw new Error("Kontroly nelze odesílat chatem.");
    const { entry } = await files.read(scope === "temp" ? { scope, threadId: scratchThread(ctx) } : { scope }, path);
    if (entry.size > 20 * 1024 * 1024) throw new Error("Soubor je větší než 20 MB.");
    return JSON.stringify({ file: { scope, path, mime: fileType(path)!.mime } });
  }, { name: "send_chat_file", description: "Připojí existující soubor k odpovědi v aktuální konverzaci: v PWA nabídne stažení a ve WhatsAppu odešle médium. Použij jen na žádost uživatele. Dočasné soubory patří pouze této konverzaci.", schema: z.object({ scope: z.enum(["project", "temp"]), path: z.string().min(1).max(300) }) });
}
