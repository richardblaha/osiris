import type { ToolModule } from "@osiris/core/tools/module.ts";
import { GotenbergClient } from "@osiris/core/files/gotenberg.ts";
import { chatFileTool } from "./chat-file.ts";
import { fileTools, searchFilesTool } from "./tools.ts";

export interface FilesToolOptions {
  /** Gotenberg for converting files to PDF; without it there is no convert_to_pdf tool. */
  gotenbergUrl?: string;
}

/** The project's files: list, read, write, edit, templates, images, PDF, full-text search, offering a file in the chat. */
export function filesModule({ gotenbergUrl }: FilesToolOptions = {}): ToolModule {
  return {
    name: "files",
    feature: "files",
    create: (host) => ({
      tools: [...fileTools(host.files, gotenbergUrl ? new GotenbergClient(gotenbergUrl) : undefined), searchFilesTool(host.fileIndex), chatFileTool(host.files)],
    }),
  };
}

export * from "./tools.ts";
export { chatFileTool } from "./chat-file.ts";
export { editText, unifiedDiff, applyPatch, type TextEdit, type EditOutcome, type EditFailure } from "./text-edit.ts";
