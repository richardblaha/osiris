import Anthropic from '@anthropic-ai/sdk';
import type { GenerateRequest, ProviderAdapter, ProviderEvent } from '../types.js';
import { mapStopReason, splitSystem, toAnthropicMessages, toAnthropicTools } from './mapping.js';

export interface AnthropicOptions {
  /** Defaults to `claude-opus-5`. */
  model?: string;
  apiKey?: string;
  /** Streaming output cap. Default 32000. */
  maxTokens?: number;
  /** `adaptive` (default) uses adaptive thinking; `off` for pre-4.6 models. */
  thinking?: 'adaptive' | 'off';
  /** Inject a pre-configured client (tests, proxies). */
  client?: Anthropic;
}

const DEFAULT_MODEL = 'claude-opus-5';

/**
 * Anthropic provider via the official SDK. Streams text, then surfaces any
 * `tool_use` blocks from the final message. Adaptive thinking is on by default.
 */
export class AnthropicAdapter implements ProviderAdapter {
  readonly id = 'anthropic';
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly thinking: 'adaptive' | 'off';

  constructor(options: AnthropicOptions = {}) {
    this.client = options.client ?? new Anthropic({ apiKey: options.apiKey });
    this.model = options.model ?? DEFAULT_MODEL;
    this.maxTokens = options.maxTokens ?? 32_000;
    this.thinking = options.thinking ?? 'adaptive';
  }

  async *generate(request: GenerateRequest): AsyncIterable<ProviderEvent> {
    const { system, rest } = splitSystem(request.messages);

    const stream = this.client.messages.stream(
      {
        model: this.model,
        max_tokens: this.maxTokens,
        ...(system ? { system } : {}),
        messages: toAnthropicMessages(rest),
        ...(request.tools.length > 0 ? { tools: toAnthropicTools(request.tools) } : {}),
        ...(this.thinking === 'adaptive' ? { thinking: { type: 'adaptive' as const } } : {}),
      },
      { signal: request.signal },
    );

    try {
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          yield { type: 'text', text: event.delta.text };
        }
      }

      const final = await stream.finalMessage();
      for (const block of final.content) {
        if (block.type === 'tool_use') {
          yield { type: 'tool-call', call: { id: block.id, name: block.name, input: block.input } };
        }
      }
      yield mapStopReason(final.stop_reason);
    } catch (cause) {
      if (request.signal?.aborted) {
        yield { type: 'done', finishReason: 'stop' };
        return;
      }
      yield { type: 'done', finishReason: 'error', error: (cause as Error).message };
    }
  }
}
