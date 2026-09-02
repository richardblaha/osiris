import type { GenerateRequest, ProviderAdapter, ProviderEvent } from '../types.js';

export interface OllamaOptions {
  /** Base URL of the Ollama server (default `http://localhost:11434`). */
  baseUrl?: string;
  model: string;
  fetchImpl?: typeof fetch;
  /**
   * Ollama `format`: `'json'` for loose JSON mode, or a JSON schema object for
   * grammar-constrained decoding. The single biggest reliability lever for small
   * local models asked to emit structured output.
   */
  format?: 'json' | Record<string, unknown>;
  /**
   * Ollama runtime `options` (merged over the defaults
   * `{ temperature: 0, num_ctx: 8192 }`) — e.g. `num_ctx`, `temperature`, `top_p`.
   */
  options?: Record<string, unknown>;
  /**
   * Ollama `keep_alive` — how long the model stays resident after a request.
   * Default `'30m'` so multi-step orchestration doesn't reload between turns.
   */
  keepAlive?: string;
}

const DEFAULT_OPTIONS: Record<string, unknown> = { temperature: 0, num_ctx: 8192 };

/**
 * Client for Ollama's native `/api/chat` endpoint (NDJSON stream, tool calling).
 * Local inference in a Docker container brought up by `@osiris/orchestrator`.
 */
export class OllamaAdapter implements ProviderAdapter {
  readonly id = 'ollama';
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly runtimeOptions: Record<string, unknown>;
  private readonly keepAlive: string;

  constructor(private readonly options: OllamaOptions) {
    this.baseUrl = (options.baseUrl ?? 'http://localhost:11434').replace(/\/$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.runtimeOptions = { ...DEFAULT_OPTIONS, ...(options.options ?? {}) };
    this.keepAlive = options.keepAlive ?? '30m';
  }

  async *generate(request: GenerateRequest): AsyncIterable<ProviderEvent> {
    const body = {
      model: this.options.model,
      stream: true,
      keep_alive: this.keepAlive,
      options: this.runtimeOptions,
      ...(this.options.format !== undefined ? { format: this.options.format } : {}),
      messages: request.messages.map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
      })),
      tools: request.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      })),
    };

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: request.signal,
      });
    } catch (cause) {
      yield { type: 'done', finishReason: 'error', error: (cause as Error).message };
      return;
    }

    if (!response.ok || !response.body) {
      yield { type: 'done', finishReason: 'error', error: `HTTP ${response.status}` };
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let sawToolCall = false;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let chunk: OllamaChatChunk;
        try {
          chunk = JSON.parse(trimmed) as OllamaChatChunk;
        } catch {
          continue;
        }
        if (chunk.error) {
          yield { type: 'done', finishReason: 'error', error: chunk.error };
          return;
        }
        if (chunk.message?.content) {
          yield { type: 'text', text: chunk.message.content };
        }
        for (const tc of chunk.message?.tool_calls ?? []) {
          sawToolCall = true;
          yield {
            type: 'tool-call',
            call: {
              id: `call_${Math.random().toString(36).slice(2)}`,
              name: tc.function.name,
              input: tc.function.arguments ?? {},
            },
          };
        }
      }
    }

    yield { type: 'done', finishReason: sawToolCall ? 'tool-calls' : 'stop' };
  }
}

interface OllamaChatChunk {
  message?: {
    content?: string;
    tool_calls?: { function: { name: string; arguments?: unknown } }[];
  };
  error?: string;
  done?: boolean;
}
