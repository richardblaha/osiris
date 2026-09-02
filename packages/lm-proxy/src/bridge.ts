/**
 * The slice of an editor Language Model API the proxy needs. The VS Code
 * extension implements this over `vscode.lm.selectChatModels()` +
 * `model.sendRequest()`; tests implement it directly.
 */

export interface LmModelInfo {
  id: string;
  vendor: string;
  family: string;
  maxInputTokens?: number;
}

export interface LmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string;
}

export interface LmToolSpec {
  name: string;
  description: string;
  parameters: unknown;
}

export interface LmChatRequest {
  model: string;
  messages: LmMessage[];
  tools?: LmToolSpec[];
}

export type LmChunk =
  | { type: 'text'; text: string }
  | { type: 'tool-call'; id: string; name: string; input: unknown }
  | { type: 'done'; reason: 'stop' | 'tool_calls' | 'length' | 'error'; error?: string };

export interface LmModelBridge {
  listModels(): Promise<LmModelInfo[]>;
  chat(request: LmChatRequest, signal?: AbortSignal): AsyncIterable<LmChunk>;
}
