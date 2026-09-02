import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { createLogger } from '@osiris/shared-core';
import {
  drainNdjson,
  type JsonRpcMessage,
  type JsonRpcNotification,
  type JsonRpcRequest,
} from './jsonrpc.js';

const log = createLogger('mcp:transport');

/** A duplex JSON-RPC channel to one MCP server. */
export interface McpTransport {
  start(): Promise<void>;
  send(message: JsonRpcRequest | JsonRpcNotification): Promise<void>;
  onMessage(handler: (message: JsonRpcMessage) => void): void;
  close(): Promise<void>;
}

export interface SpawnLike {
  (
    command: string,
    args: string[],
    options: { env: NodeJS.ProcessEnv; cwd?: string },
  ): ChildProcessWithoutNullStreams;
}

export interface StdioTransportOptions {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  spawnImpl?: SpawnLike;
}

/** Newline-delimited JSON-RPC over a child process's stdin/stdout. */
export class StdioTransport implements McpTransport {
  private child?: ChildProcessWithoutNullStreams;
  private buffer = '';
  private handler: (message: JsonRpcMessage) => void = () => {};

  constructor(private readonly options: StdioTransportOptions) {}

  async start(): Promise<void> {
    const spawnImpl = this.options.spawnImpl ?? (spawn as unknown as SpawnLike);
    const child = spawnImpl(this.options.command, this.options.args ?? [], {
      env: { ...process.env, ...this.options.env },
      cwd: this.options.cwd,
    });
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk;
      const { messages, rest } = drainNdjson(this.buffer);
      this.buffer = rest;
      for (const message of messages) this.handler(message);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) =>
      log.debug('%s stderr: %s', this.options.command, chunk.trim()),
    );
    child.on('exit', (code) => log.info('%s exited (%s)', this.options.command, code));
  }

  async send(message: JsonRpcRequest | JsonRpcNotification): Promise<void> {
    if (!this.child) throw new Error('transport not started');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  onMessage(handler: (message: JsonRpcMessage) => void): void {
    this.handler = handler;
  }

  async close(): Promise<void> {
    this.child?.stdin.end();
    this.child?.kill();
    this.child = undefined;
  }
}

export interface HttpTransportOptions {
  url: string;
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
}

/**
 * MCP Streamable HTTP, request/response only: each JSON-RPC request is POSTed and
 * its response read from the body. Server-initiated notifications are not
 * delivered (Osiris only needs `tools/list` + `tools/call`).
 */
export class HttpTransport implements McpTransport {
  private handler: (message: JsonRpcMessage) => void = () => {};
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: HttpTransportOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async start(): Promise<void> {}

  async send(message: JsonRpcRequest | JsonRpcNotification): Promise<void> {
    if (!('id' in message)) return; // notifications are fire-and-forget, nothing to await
    const res = await this.fetchImpl(this.options.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...this.options.headers,
      },
      body: JSON.stringify(message),
    });
    if (!res.ok) throw new Error(`MCP HTTP ${res.status} for ${message.method}`);
    const text = await res.text();
    // Accept a bare JSON body or a single `data:` SSE frame.
    const payload = text.startsWith('data:')
      ? text
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim())
          .join('')
      : text.trim();
    if (payload) this.handler(JSON.parse(payload) as JsonRpcMessage);
  }

  onMessage(handler: (message: JsonRpcMessage) => void): void {
    this.handler = handler;
  }

  async close(): Promise<void> {}
}
