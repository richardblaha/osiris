import type { McpServerConfig } from '@richardblaha/shared-core';
import type { Tool } from '@richardblaha/agent-core';
import type { McpServerSpec } from './config.js';
import { McpPool, type McpServerStatus } from './pool.js';
import { mcpToolsForCrew } from './crew-tools.js';
import type { McpTransport } from './transport.js';

export type McpRegistryStatus = McpServerStatus;

/** Normalise the shared-core `McpServerConfig` shape to an `@richardblaha/mcp` spec. */
export function toServerSpec(config: McpServerConfig): McpServerSpec {
  return {
    id: config.id,
    transport: config.transport,
    command: config.command,
    args: config.args,
    env: config.env,
    url: config.url,
    timeoutMs: config.timeoutMs,
    enabled: config.enabled !== false,
  };
}

/**
 * A long-lived, reloadable MCP integration: `load(configs)` (re)starts the
 * servers, `asTools()` exposes their tools for an agent loop, `status()` reports
 * per-server health. Wraps a fresh {@link McpPool} on each load.
 */
export class McpRegistry {
  private pool?: McpPool;

  constructor(private readonly transportFactory?: (spec: McpServerSpec) => McpTransport) {}

  async load(configs: McpServerConfig[]): Promise<void> {
    await this.disposeAll();
    this.pool = await McpPool.start(configs.map(toServerSpec), this.transportFactory);
  }

  asTools(): Tool[] {
    return this.pool ? mcpToolsForCrew(this.pool) : [];
  }

  status(): McpRegistryStatus[] {
    return this.pool?.status() ?? [];
  }

  /** The underlying pool, for `call()` / `toolsFor()` / selectors. */
  get connection(): McpPool | undefined {
    return this.pool;
  }

  async disposeAll(): Promise<void> {
    await this.pool?.close();
    this.pool = undefined;
  }
}
