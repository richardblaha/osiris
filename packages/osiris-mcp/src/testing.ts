import type { JsonRpcMessage, JsonRpcNotification, JsonRpcRequest } from './jsonrpc.js';
import type { McpTransport } from './transport.js';

export interface FakeMcpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  handler: (
    args: unknown,
  ) => { text: string; isError?: boolean } | Promise<{ text: string; isError?: boolean }>;
}

/**
 * An in-process {@link McpTransport} backed by a fixed tool set — for testing an
 * MCP integration without spawning a server. Pass it to `McpPool.start(specs,
 * () => new FakeMcpTransport(tools))`.
 */
export class FakeMcpTransport implements McpTransport {
  private handler: (m: JsonRpcMessage) => void = () => {};
  readonly calls: { name: string; args: unknown }[] = [];

  constructor(private readonly tools: FakeMcpTool[]) {}

  async start(): Promise<void> {}

  async send(message: JsonRpcRequest | JsonRpcNotification): Promise<void> {
    if (!('id' in message)) return;
    const emit = (body: Record<string, unknown>): void =>
      queueMicrotask(() => this.handler({ jsonrpc: '2.0', id: message.id, ...body }));

    if (message.method === 'initialize') return emit({ result: { protocolVersion: 'test' } });
    if (message.method === 'tools/list') {
      return emit({
        result: {
          tools: this.tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema ?? { type: 'object' },
          })),
        },
      });
    }
    if (message.method === 'tools/call') {
      const { name, arguments: args } = message.params as { name: string; arguments: unknown };
      this.calls.push({ name, args });
      const tool = this.tools.find((t) => t.name === name);
      if (!tool) return emit({ error: { code: -32602, message: `no such tool: ${name}` } });
      const out = await tool.handler(args);
      return emit({
        result: { content: [{ type: 'text', text: out.text }], isError: out.isError },
      });
    }
    return emit({ result: {} });
  }

  onMessage(handler: (m: JsonRpcMessage) => void): void {
    this.handler = handler;
  }

  async close(): Promise<void> {}
}
