/**
 * Minimal Model Context Protocol client over a stdio transport.
 *
 * Speaks newline-delimited JSON-RPC 2.0 to a child process, implementing just
 * the slice Osiris needs: `initialize`, `notifications/initialized`,
 * `tools/list`, `tools/call` and `resources/list`.
 */
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { createLogger, type McpServerConfig, type McpToolDescriptor } from '@osiris/shared-core';

const log = createLogger('ai:mcp');

const PROTOCOL_VERSION = '2024-11-05';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}
interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface McpToolResult {
  content: { type: string; text?: string }[];
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

export interface SpawnLike {
  (
    command: string,
    args: string[],
    options: { env: NodeJS.ProcessEnv },
  ): ChildProcessWithoutNullStreams;
}

export class McpStdioClient {
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (reason: Error) => void; timer: NodeJS.Timeout }
  >();
  private stdoutBuffer = '';
  private initialized = false;
  private readonly timeoutMs: number;

  constructor(
    private readonly config: McpServerConfig,
    private readonly spawnImpl: SpawnLike = spawn as unknown as SpawnLike,
  ) {
    this.timeoutMs = config.timeoutMs ?? 15000;
  }

  get id(): string {
    return this.config.id;
  }

  get isRunning(): boolean {
    return this.child !== undefined && this.child.exitCode === null;
  }

  async start(): Promise<void> {
    if (this.config.transport !== 'stdio') {
      throw new McpError(`Unsupported transport: ${this.config.transport}`, this.config.id);
    }
    if (!this.config.command) {
      throw new McpError('stdio server requires a "command"', this.config.id);
    }

    const child = this.spawnImpl(this.config.command, this.config.args ?? [], {
      env: { ...process.env, ...this.config.env },
    });
    this.child = child;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onStdout(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) =>
      log.debug('[%s stderr] %s', this.config.id, chunk.trimEnd()),
    );
    child.on('exit', (code) => {
      log.info('mcp server %s exited with %s', this.config.id, code);
      this.failAllPending(new McpError(`Server exited (code ${code})`, this.config.id));
    });
    child.on('error', (err) => this.failAllPending(new McpError(err.message, this.config.id)));

    const initResult = (await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      clientInfo: { name: 'osiris-ai', version: '0.1.0' },
    })) as { protocolVersion?: string };
    log.info('mcp %s initialized (protocol %s)', this.config.id, initResult.protocolVersion ?? '?');
    this.notify('notifications/initialized');
    this.initialized = true;
  }

  async listTools(): Promise<McpToolDescriptor[]> {
    this.assertReady();
    const result = (await this.request('tools/list')) as {
      tools?: { name: string; description?: string; inputSchema?: unknown }[];
    };
    return (result.tools ?? []).map((tool) => ({
      serverId: this.config.id,
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema ?? { type: 'object' },
    }));
  }

  async callTool(name: string, args: unknown): Promise<McpToolResult> {
    this.assertReady();
    const result = (await this.request('tools/call', {
      name,
      arguments: args ?? {},
    })) as McpToolResult;
    return { content: result.content ?? [], isError: result.isError };
  }

  async listResources(): Promise<{ uri: string; name?: string }[]> {
    this.assertReady();
    const result = (await this.request('resources/list')) as {
      resources?: { uri: string; name?: string }[];
    };
    return result.resources ?? [];
  }

  async stop(): Promise<void> {
    this.failAllPending(new McpError('Client stopped', this.config.id));
    const child = this.child;
    this.child = undefined;
    this.initialized = false;
    if (!child || child.exitCode !== null) {
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 2000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill('SIGTERM');
    });
  }

  private assertReady(): void {
    if (!this.initialized || !this.isRunning) {
      throw new McpError('Client is not initialized', this.config.id);
    }
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newlineIndex = this.stdoutBuffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line) {
        this.handleMessage(line);
      }
      newlineIndex = this.stdoutBuffer.indexOf('\n');
    }
  }

  private handleMessage(line: string): void {
    let message: JsonRpcResponse;
    try {
      message = JSON.parse(line) as JsonRpcResponse;
    } catch {
      log.warn('mcp %s: non-JSON line ignored: %s', this.config.id, line.slice(0, 120));
      return;
    }
    if (typeof message.id !== 'number') {
      return; // server-initiated notification/request — not handled in this slice
    }
    const entry = this.pending.get(message.id);
    if (!entry) {
      return;
    }
    this.pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) {
      entry.reject(
        new McpError(`${message.error.message} (code ${message.error.code})`, this.config.id),
      );
    } else {
      entry.resolve(message.result ?? {});
    }
  }

  private request(method: string, params?: unknown): Promise<unknown> {
    const child = this.child;
    if (!child || child.stdin.destroyed) {
      return Promise.reject(new McpError('Server process is not available', this.config.id));
    }
    const id = this.nextId++;
    const payload: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new McpError(`Request "${method}" timed out after ${this.timeoutMs}ms`, this.config.id),
        );
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify(payload)}\n`, (err) => {
        if (err) {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(new McpError(err.message, this.config.id));
        }
      });
    });
  }

  private notify(method: string, params?: unknown): void {
    this.child?.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  private failAllPending(error: Error): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }
}
