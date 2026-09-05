import type { Tool } from '@richardblaha/agent-core';
import { flattenMcpResult } from './client.js';
import type { McpPool } from './pool.js';

/**
 * Expose an MCP pool's tools to the Osiris crew as agent-core `Tool`s. Names are
 * `<serverId>__<tool>`. An agent opts in by listing `mcp` (all servers) or
 * `mcp:<serverId>` in its `tools:` frontmatter — see `mcpToolNamesFor`.
 */
export function mcpToolsForCrew(pool: McpPool): Tool[] {
  return pool.tools().map((info) => ({
    name: info.qualifiedName,
    description: `[MCP ${info.serverId}] ${info.description ?? info.name}`,
    inputSchema: info.inputSchema ?? { type: 'object' },
    invoke: async (input) => {
      try {
        return flattenMcpResult(await pool.call(info.qualifiedName, input));
      } catch (cause) {
        return `error: ${(cause as Error).message}`;
      }
    },
  }));
}

/**
 * Given an agent's `tools:` list, return the MCP tool names it should get:
 * `mcp` → every pooled tool, `mcp:<serverId>` → that server's tools.
 */
export function mcpToolNamesFor(agentTools: string[], pool: McpPool): string[] {
  const names = new Set<string>();
  for (const entry of agentTools) {
    if (entry === 'mcp' || entry === 'mcp:*') {
      for (const t of pool.tools()) names.add(t.qualifiedName);
    } else if (entry.startsWith('mcp:')) {
      for (const t of pool.toolsFor(entry.slice(4))) names.add(t.qualifiedName);
    }
  }
  return [...names];
}
