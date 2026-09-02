import { createLogger } from '@osiris/shared-core';
import { isResponse, type JsonRpcResponse } from './jsonrpc.js';
import type { McpTransport } from './transport.js';

const log = createLogger('mcp:client');

const PROTOCOL_VERSION = '2025-06-18';

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema: unknown;
}

export interface McpCallResult {
  content: { type: string; text?: string; [k: string]: unknown }[];
  isError?: boolean;
}

export class McpError extends Error {
  constructor(
    message: string,
    readonly serverId: string,
  ) {
    super(message);
    this.name = 'McpError';
  }
}

/** A JSON-RPC MCP client speaking the slice Osiris needs. */
export class McpClient {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (r: JsonRpcResponse) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();

  constructor(
    readonly serverId: string,
    private readonly transport: McpTransport,
    private readonly timeoutMs = 20_000,
  ) {
    transport.onMessage((message) => {
      if (isResponse(message)) {
        const waiter = this.pending.get(message.id);
        if (!waiter) return;
        clearTimeout(waiter.timer);
        this.pending.delete(message.id);
        waiter.resolve(message);
      }
    });
  }

  private request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new McpError(`${method} timed out after ${this.timeoutMs}ms`, this.serverId));
      }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(id, {
        resolve: (r) =>
          r.error
            ? reject(new McpError(`${method}: ${r.error.message}`, this.serverId))
            : resolve(r.result),
        reject,
        timer,
      });
      void this.transport.send({ jsonrpc: '2.0', id, method, params }).catch((cause: unknown) => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(cause as Error);
      });
    });
  }

  async initialize(): Promise<void> {
    await this.transport.start();
    await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'osiris', version: '0.1.0' },
    });
    await this.transport.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    log.info('%s initialized', this.serverId);
  }

  async listTools(): Promise<McpToolInfo[]> {
    const result = (await this.request('tools/list')) as { tools?: McpToolInfo[] };
    return result.tools ?? [];
  }

  async callTool(name: string, args: unknown): Promise<McpCallResult> {
    return (await this.request('tools/call', {
      name,
      arguments: args ?? {},
    })) as McpCallResult;
  }

  async close(): Promise<void> {
    for (const { timer } of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
    await this.transport.close();
  }
}

/** Flatten an MCP tool result into a plain string for the agent loop. */
export function flattenMcpResult(result: McpCallResult): string {
  const text = result.content
    .map((part) => part.text ?? (part.type === 'text' ? '' : `[${part.type}]`))
    .filter(Boolean)
    .join('\n');
  return result.isError ? `error: ${text || 'tool call failed'}` : text || '(no output)';
}
