import * as vscode from 'vscode';
import type { LmChatRequest, LmChunk, LmModelBridge, LmModelInfo } from '@osiris/lm-proxy';

/** True when the running VS Code exposes the stable Language Model API. */
export function hasLanguageModelApi(): boolean {
  return (
    typeof (vscode as { lm?: unknown }).lm === 'object' &&
    typeof vscode.lm?.selectChatModels === 'function'
  );
}

function toVscodeMessages(messages: LmChatRequest['messages']): vscode.LanguageModelChatMessage[] {
  return messages.map((m) => {
    if (m.role === 'assistant') return vscode.LanguageModelChatMessage.Assistant(m.content);
    if (m.role === 'tool') {
      return vscode.LanguageModelChatMessage.User(
        `[tool result${m.toolCallId ? ` ${m.toolCallId}` : ''}]\n${m.content}`,
      );
    }
    // VS Code's LM API has no system role — fold it into a user turn.
    return vscode.LanguageModelChatMessage.User(m.content);
  });
}

function toVscodeTools(tools: LmChatRequest['tools']): vscode.LanguageModelChatTool[] | undefined {
  if (!tools?.length) return undefined;
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.parameters ?? { type: 'object' },
  }));
}

/**
 * An {@link LmModelBridge} over `vscode.lm`. The model is chosen by `request.model`
 * (`<vendor>/<family>` or a substring); otherwise the first available Copilot
 * model is used. Tool calls the model makes are surfaced as `tool-call` chunks.
 */
export function createVscodeLmBridge(): LmModelBridge {
  const pickModel = async (spec: string): Promise<vscode.LanguageModelChat | undefined> => {
    const all = await vscode.lm.selectChatModels();
    if (all.length === 0) return undefined;
    if (!spec) return all[0];
    const [vendor, family] = spec.includes('/') ? spec.split('/') : [undefined, spec];
    return (
      all.find((m) => (!vendor || m.vendor === vendor) && (!family || m.family === family)) ??
      all.find((m) => `${m.vendor}/${m.family}`.includes(spec) || m.id.includes(spec)) ??
      all[0]
    );
  };

  return {
    async listModels(): Promise<LmModelInfo[]> {
      const models = await vscode.lm.selectChatModels();
      return models.map((m) => ({
        id: `${m.vendor}/${m.family}`,
        vendor: m.vendor,
        family: m.family,
        maxInputTokens: m.maxInputTokens,
      }));
    },

    async *chat(request: LmChatRequest): AsyncGenerator<LmChunk> {
      const model = await pickModel(request.model);
      if (!model) {
        yield { type: 'done', reason: 'error', error: 'no language model available in the editor' };
        return;
      }
      const source = new vscode.CancellationTokenSource();
      try {
        const response = await model.sendRequest(
          toVscodeMessages(request.messages),
          { tools: toVscodeTools(request.tools) },
          source.token,
        );
        let sawToolCall = false;
        for await (const part of response.stream) {
          if (part instanceof vscode.LanguageModelTextPart) {
            yield { type: 'text', text: part.value };
          } else if (part instanceof vscode.LanguageModelToolCallPart) {
            sawToolCall = true;
            yield { type: 'tool-call', id: part.callId, name: part.name, input: part.input };
          }
        }
        yield { type: 'done', reason: sawToolCall ? 'tool_calls' : 'stop' };
      } catch (cause) {
        yield { type: 'done', reason: 'error', error: (cause as Error).message };
      } finally {
        source.dispose();
      }
    },
  };
}
