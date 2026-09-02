import { createLogger } from '@osiris/shared-core';
import { McpClient, type McpCallResult, type McpToolInfo } from './client.js';
import type { McpServerSpec } from './config.js';
import { HttpTransport, StdioTransport, type McpTransport } from './transport.js';

const log = createLogger('mcp:pool');

export interface PooledTool extends McpToolInfo {
  serverId: string;
  /** `<serverId>__<tool>` — the name the crew sees. */
  qualifiedName: string;
}

function makeTransport(spec: McpServerSpec): McpTransport {
  if (spec.transport === 'http') {
    if (!spec.url) throw new Error(`MCP server "${spec.id}" has transport "http" but no url`);
    return new HttpTransport({ url: spec.url, headers: spec.headers });
  }
  if (!spec.command)
    throw new Error(`MCP server "${spec.id}" has transport "stdio" but no command`);
  return new StdioTransport({ command: spec.command, args: spec.args, env: spec.env });
}

/**
 * Starts every enabled MCP server, aggregates their tools under a
 * `<serverId>__<tool>` namespace, and routes `call()` back to the right client.
 * A server that fails to start is logged and skipped — never fatal.
 */
export class McpPool {
  private readonly clients = new Map<string, McpClient>();
  private readonly toolIndex = new Map<string, { serverId: string; toolName: string }>();
  private toolList: PooledTool[] = [];

  static async start(
    specs: McpServerSpec[],
    transportFactory: (spec: McpServerSpec) => McpTransport = makeTransport,
  ): Promise<McpPool> {
    const pool = new McpPool();
    for (const spec of specs) {
      if (!spec.enabled) continue;
      try {
        const client = new McpClient(spec.id, transportFactory(spec), spec.timeoutMs);
        await client.initialize();
        const tools = await client.listTools();
        pool.clients.set(spec.id, client);
        for (const tool of tools) {
          const qualifiedName = `${spec.id}__${tool.name}`;
          pool.toolIndex.set(qualifiedName, { serverId: spec.id, toolName: tool.name });
          pool.toolList.push({ ...tool, serverId: spec.id, qualifiedName });
        }
        log.info('%s: %d tool(s)', spec.id, tools.length);
      } catch (cause) {
        log.warn('MCP server "%s" unavailable: %s', spec.id, (cause as Error).message);
      }
    }
    return pool;
  }

  tools(): PooledTool[] {
    return [...this.toolList];
  }

  /** Tools from one server, or all of them. */
  toolsFor(serverId?: string): PooledTool[] {
    return serverId ? this.toolList.filter((t) => t.serverId === serverId) : this.tools();
  }

  async call(qualifiedName: string, args: unknown): Promise<McpCallResult> {
    const route = this.toolIndex.get(qualifiedName);
    if (!route) throw new Error(`no MCP tool "${qualifiedName}"`);
    const client = this.clients.get(route.serverId);
    if (!client) throw new Error(`MCP server "${route.serverId}" is not connected`);
    return client.callTool(route.toolName, args);
  }

  get size(): number {
    return this.clients.size;
  }

  async close(): Promise<void> {
    await Promise.all([...this.clients.values()].map((c) => c.close()));
    this.clients.clear();
    this.toolIndex.clear();
    this.toolList = [];
  }
}
