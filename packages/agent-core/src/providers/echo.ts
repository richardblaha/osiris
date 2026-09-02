import type { GenerateRequest, ProviderAdapter, ProviderEvent } from '../types.js';

/**
 * Offline, deterministic provider used for tests and a zero-config first run.
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
      const name = toolMatch[1] ?? '';
      const rawInput = toolMatch[2] ?? '{}';
      let input: unknown = {};
      try {
        input = JSON.parse(rawInput);
      } catch {
        input = { raw: rawInput };
      }
      if (request.tools.some((t) => t.name === name)) {
        yield { type: 'tool-call', call: { id: `call_${Date.now()}`, name, input } };
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
