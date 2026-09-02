import { createLogger, type McpServerConfig, type McpToolDescriptor } from '@osiris/shared-core';
import type { Tool } from '@osiris/agent-core';
import { McpError, McpStdioClient, type SpawnLike } from './client.js';

const log = createLogger('ai:mcp-registry');

export interface RegistryStatus {
  id: string;
  running: boolean;
  toolCount: number;
  error?: string;
}

/**
 * Owns the lifecycle of the configured MCP servers and turns their advertised
 * tools into {@link Tool}s the {@link AgentOrchestrator} can call. Tool names are
 * namespaced as `<serverId>.<toolName>` to avoid collisions.
 */
export class McpRegistry {
  private readonly clients = new Map<string, McpStdioClient>();
  private readonly tools = new Map<string, McpToolDescriptor>();
  private readonly errors = new Map<string, string>();

  constructor(private readonly spawnImpl?: SpawnLike) {}

  async load(configs: McpServerConfig[]): Promise<void> {
    await this.disposeAll();
    this.errors.clear();
    await Promise.all(
      configs.filter((config) => config.enabled !== false).map((config) => this.startOne(config)),
    );
  }

  private async startOne(config: McpServerConfig): Promise<void> {
    if (config.transport !== 'stdio') {
      this.errors.set(config.id, `transport "${config.transport}" is not supported yet`);
      return;
    }
    const client = new McpStdioClient(config, this.spawnImpl);
    try {
      await client.start();
      const descriptors = await client.listTools();
      for (const descriptor of descriptors) {
        this.tools.set(`${config.id}.${descriptor.name}`, descriptor);
      }
      this.clients.set(config.id, client);
      log.info('mcp server %s ready with %d tool(s)', config.id, descriptors.length);
    } catch (cause) {
      const message = cause instanceof McpError ? cause.message : (cause as Error).message;
      this.errors.set(config.id, message);
      log.warn('mcp server %s failed: %s', config.id, message);
      await client.stop().catch(() => undefined);
    }
  }

  /** The MCP tools, adapted for the orchestrator. */
  asTools(): Tool[] {
    return [...this.tools.entries()].map(([namespacedName, descriptor]) => ({
      name: namespacedName,
      description:
        descriptor.description ?? `MCP tool ${descriptor.name} from ${descriptor.serverId}`,
      inputSchema: descriptor.inputSchema,
      invoke: async (input: unknown) => {
        const client = this.clients.get(descriptor.serverId);
        if (!client) {
          throw new McpError(`Server ${descriptor.serverId} is not running`, descriptor.serverId);
        }
        const result = await client.callTool(descriptor.name, input);
        const text = result.content
          .map((part) => (part.type === 'text' ? (part.text ?? '') : `[${part.type}]`))
          .join('\n');
        if (result.isError) {
          throw new Error(text || 'MCP tool reported an error');
        }
        return text;
      },
    }));
  }

  status(): RegistryStatus[] {
    const ids = new Set<string>([...this.clients.keys(), ...this.errors.keys()]);
    return [...ids].map((id) => ({
      id,
      running: this.clients.get(id)?.isRunning ?? false,
      toolCount: [...this.tools.keys()].filter((key) => key.startsWith(`${id}.`)).length,
      error: this.errors.get(id),
    }));
  }

  async disposeAll(): Promise<void> {
    this.tools.clear();
    await Promise.all(
      [...this.clients.values()].map((client) => client.stop().catch(() => undefined)),
    );
    this.clients.clear();
  }
}
