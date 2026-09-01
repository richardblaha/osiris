import type { GenerateRequest, ProviderAdapter, ProviderEvent } from './types.js';

/**
 * Offline, deterministic provider used for tests and for a zero-config first
 * run. It "reasons" with simple rules:
 *   - if the last user message contains `use tool <name>: <json>` it emits that
 *     tool call once, then stops on the next turn;
 *   - otherwise it echoes a short acknowledgement token by token.
 */
export class EchoProviderAdapter implements ProviderAdapter {
  readonly id = 'echo';

  async *generate(request: GenerateRequest): AsyncIterable<ProviderEvent> {
    const lastUser = [...request.messages].reverse().find((m) => m.role === 'user');
    const justRanTool = request.messages.at(-1)?.role === 'tool';
    const text = lastUser?.content ?? '';

    const toolMatch = /use tool\s+([\w.-]+)\s*:\s*(\{.*\})/is.exec(text);
    if (toolMatch && !justRanTool) {
      const [, name, rawInput] = toolMatch;
      let input: unknown = {};
      try {
        input = JSON.parse(rawInput!);
      } catch {
        input = { raw: rawInput };
      }
      if (request.tools.some((t) => t.name === name)) {
        yield { type: 'tool-call', call: { id: `call_${Date.now()}`, name: name!, input } };
        yield { type: 'done', finishReason: 'tool-calls' };
        return;
      }
    }

    const reply = justRanTool
      ? 'Done — I used the tool and here is the result summary.'
      : `You said: ${text.slice(0, 200)}`;
    for (const word of reply.split(/(\s+)/)) {
      yield { type: 'text', text: word };
    }
    yield { type: 'done', finishReason: 'stop' };
  }
}

export interface OpenAiCompatibleOptions {
  endpoint: string;
  model: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Minimal streaming client for an OpenAI-compatible `/chat/completions` endpoint
 * with tool calling. Kept dependency-free; the concrete backend is the user's.
 */
export class OpenAiCompatibleAdapter implements ProviderAdapter {
  readonly id = 'openai-compatible';
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: OpenAiCompatibleOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async *generate(request: GenerateRequest): AsyncIterable<ProviderEvent> {
    const body = {
      model: this.options.model,
      stream: true,
      messages: request.messages.map((m) => ({
        role: m.role === 'tool' ? 'tool' : m.role,
        content: m.content,
        tool_call_id: m.toolCallId,
      })),
      tools: request.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      })),
    };

    let response: Response;
    try {
      response = await this.fetchImpl(
        `${this.options.endpoint.replace(/\/$/, '')}/chat/completions`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
          },
          body: JSON.stringify(body),
          signal: request.signal,
        },
      );
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
    const toolAccum = new Map<number, { id: string; name: string; args: string }>();

    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) {
          continue;
        }
        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') {
          continue;
        }
        let chunk: OpenAiStreamChunk;
        try {
          chunk = JSON.parse(payload) as OpenAiStreamChunk;
        } catch {
          continue;
        }
        const delta = chunk.choices?.[0]?.delta;
        if (delta?.content) {
          yield { type: 'text', text: delta.content };
        }
        for (const tc of delta?.tool_calls ?? []) {
          const slot = toolAccum.get(tc.index) ?? { id: '', name: '', args: '' };
          slot.id = tc.id ?? slot.id;
          slot.name = tc.function?.name ?? slot.name;
          slot.args += tc.function?.arguments ?? '';
          toolAccum.set(tc.index, slot);
        }
      }
    }

    if (toolAccum.size > 0) {
      for (const slot of toolAccum.values()) {
        let input: unknown = {};
        try {
          input = slot.args ? JSON.parse(slot.args) : {};
        } catch {
          input = { raw: slot.args };
        }
        yield {
          type: 'tool-call',
          call: {
            id: slot.id || `call_${Math.random().toString(36).slice(2)}`,
            name: slot.name,
            input,
          },
        };
      }
      yield { type: 'done', finishReason: 'tool-calls' };
      return;
    }

    yield { type: 'done', finishReason: 'stop' };
  }
}

interface OpenAiStreamChunk {
  choices?: {
    delta?: {
      content?: string;
      tool_calls?: {
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }[];
    };
  }[];
}
