import { createLogger } from '@osiris/shared-core';
import type { ChatMessage, ProviderAdapter, Tool, ToolCall } from './types.js';

const log = createLogger('ai:orchestrator');

export interface AgentEvents {
  onText?(text: string): void;
  onToolCall?(call: ToolCall): void;
  onToolResult?(call: ToolCall, result: unknown, isError: boolean): void;
  onIteration?(index: number): void;
}

export interface RunOptions {
  prompt: string;
  system?: string;
  history?: ChatMessage[];
  maxIterations?: number;
  signal?: AbortSignal;
  events?: AgentEvents;
}

export interface RunResult {
  messages: ChatMessage[];
  text: string;
  iterations: number;
  finishReason: 'stop' | 'max-iterations' | 'aborted' | 'error';
  error?: string;
}

/**
 * A provider-agnostic agent loop: ask the provider, stream text, run any tool
 * calls it requests, feed the results back, repeat until the provider stops or
 * `maxIterations` is hit.
 */
export class AgentOrchestrator {
  constructor(
    private readonly provider: ProviderAdapter,
    private readonly tools: Map<string, Tool> = new Map(),
  ) {}

  setTools(tools: Tool[]): void {
    this.tools.clear();
    for (const tool of tools) {
      this.tools.set(tool.name, tool);
    }
  }

  get toolSpecs(): Tool[] {
    return [...this.tools.values()];
  }

  async run(options: RunOptions): Promise<RunResult> {
    const maxIterations = options.maxIterations ?? 8;
    const messages: ChatMessage[] = [
      ...(options.system ? [{ role: 'system' as const, content: options.system }] : []),
      ...(options.history ?? []),
      { role: 'user', content: options.prompt },
    ];

    let assembledText = '';
    let iterations = 0;

    while (iterations < maxIterations) {
      if (options.signal?.aborted) {
        return { messages, text: assembledText, iterations, finishReason: 'aborted' };
      }
      iterations++;
      options.events?.onIteration?.(iterations);

      const pendingToolCalls: ToolCall[] = [];
      let turnText = '';
      let finishReason: 'stop' | 'tool-calls' | 'length' | 'error' = 'stop';
      let providerError: string | undefined;

      try {
        for await (const event of this.provider.generate({
          messages,
          tools: this.toolSpecs.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
          signal: options.signal,
        })) {
          if (event.type === 'text') {
            turnText += event.text;
            assembledText += event.text;
            options.events?.onText?.(event.text);
          } else if (event.type === 'tool-call') {
            pendingToolCalls.push(event.call);
            options.events?.onToolCall?.(event.call);
          } else {
            finishReason = event.finishReason;
            providerError = event.error;
          }
        }
      } catch (cause) {
        return {
          messages,
          text: assembledText,
          iterations,
          finishReason: 'error',
          error: (cause as Error).message,
        };
      }

      messages.push({
        role: 'assistant',
        content: turnText,
        toolCalls: pendingToolCalls.length ? pendingToolCalls : undefined,
      });

      if (finishReason === 'error') {
        return {
          messages,
          text: assembledText,
          iterations,
          finishReason: 'error',
          error: providerError,
        };
      }

      if (pendingToolCalls.length === 0) {
        return { messages, text: assembledText, iterations, finishReason: 'stop' };
      }

      for (const call of pendingToolCalls) {
        const tool = this.tools.get(call.name);
        let result: unknown;
        let isError = false;
        if (!tool) {
          result = `No such tool: ${call.name}`;
          isError = true;
        } else {
          try {
            result = await tool.invoke(call.input, options.signal);
          } catch (cause) {
            result = (cause as Error).message;
            isError = true;
          }
        }
        log.debug('tool %s -> %s', call.name, isError ? 'error' : 'ok');
        options.events?.onToolResult?.(call, result, isError);
        messages.push({
          role: 'tool',
          toolCallId: call.id,
          content: typeof result === 'string' ? result : JSON.stringify(result),
        });
      }
    }

    return { messages, text: assembledText, iterations, finishReason: 'max-iterations' };
  }
}
