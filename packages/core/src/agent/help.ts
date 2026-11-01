import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { getRunContext, type RunContext } from "./context.ts";

export interface HelpItem {
  name: string;
  description: string;
}

export interface HelpMcpServer {
  name: string;
  tools: HelpItem[];
}

export interface HelpSummary {
  tools: HelpItem[];
  mcpServers: HelpMcpServer[];
  skills: HelpItem[];
}

/** Whether a user message is the direct `/help` chat command. */
export const isHelpCommand = (text: string): boolean => /^\/help$/i.test(text.trim());

const brief = (text: string): string => text.trim().split(/\r?\n/)[0]?.trim() ?? "";

/** Formats the active capabilities for a user in a project (tools, MCP servers with their tools, and skills). */
export function formatHelp({ tools, mcpServers, skills }: HelpSummary): string {
  const toolLines = tools.length
    ? tools.map((t) => `- **${t.name}**: ${brief(t.description)}`).join("\n")
    : "_Žádné dostupné nástroje._";

  const mcpLines = mcpServers.length
    ? mcpServers
        .map((s) => {
          const sub = s.tools.length
            ? s.tools.map((t) => `  - **${t.name}**: ${brief(t.description)}`).join("\n")
            : "  - _Žádné dostupné nástroje._";
          return `- **${s.name}**\n${sub}`;
        })
        .join("\n")
    : "_Žádné aktivní MCP servery._";

  const skillLines = skills.length
    ? skills.map((s) => `- **${s.name}**: ${brief(s.description)}`).join("\n")
    : "_Žádné dostupné dovednosti._";

  return `## Nástroje\n${toolLines}\n\n## MCP servery\n${mcpLines}\n\n## Dovednosti\n${skillLines}`;
}

/** Built-in tool that returns the active capabilities (tools, MCP servers, skills) for the current user. */
export function helpTool(describe: (ctx: RunContext) => Promise<string>) {
  return tool(
    async (_input, config) => describe(getRunContext(config)),
    {
      name: "help",
      description:
        "Vypíše všechny aktuálně dostupné možnosti asistenta pro tohoto uživatele: nástroje, MCP servery (včetně jejich nástrojů) a dovednosti (skilly).",
      schema: z.object({}),
    },
  );
}
