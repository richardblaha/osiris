/** Pure translation between Osiris `ChatMessage`s and the Anthropic Messages API. */
import type Anthropic from '@anthropic-ai/sdk';
import type { ChatMessage, ProviderEvent, ToolSpec } from '../types.js';

export function splitSystem(messages: ChatMessage[]): { system: string; rest: ChatMessage[] } {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');
  return { system, rest: messages.filter((m) => m.role !== 'system') };
}

export function toAnthropicMessages(messages: ChatMessage[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  for (const message of messages) {
    if (message.role === 'user') {
      out.push({ role: 'user', content: message.content });
      continue;
    }
    if (message.role === 'assistant') {
      const blocks: Anthropic.ContentBlockParam[] = [];
      if (message.content.trim()) {
        blocks.push({ type: 'text', text: message.content });
      }
      for (const call of message.toolCalls ?? []) {
        blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input ?? {} });
      }
      out.push({ role: 'assistant', content: blocks.length > 0 ? blocks : message.content });
      continue;
    }
    if (message.role === 'tool') {
      out.push({
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: message.toolCallId ?? '', content: message.content },
        ],
      });
    }
  }
  return out;
}

export function toAnthropicTools(tools: ToolSpec[]): Anthropic.Tool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: (tool.inputSchema ?? { type: 'object' }) as Anthropic.Tool.InputSchema,
  }));
}

export function mapStopReason(
  reason: Anthropic.Message['stop_reason'],
): Extract<ProviderEvent, { type: 'done' }> {
  switch (reason) {
    case 'tool_use':
      return { type: 'done', finishReason: 'tool-calls' };
    case 'max_tokens':
      return { type: 'done', finishReason: 'length' };
    case 'refusal':
      return { type: 'done', finishReason: 'error', error: 'the model refused the request' };
    default:
      return { type: 'done', finishReason: 'stop' };
  }
}
