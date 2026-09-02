/** Shared shapes for the agent orchestrator and its provider adapters. */

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  role: Role;
  content: string;
  /** For `tool` messages: which tool call this is answering. */
  toolCallId?: string;
  /** For `assistant` messages that requested tools. */
  toolCalls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON schema for the tool input. */
  inputSchema: unknown;
}

export interface Tool extends ToolSpec {
  invoke(input: unknown, signal?: AbortSignal): Promise<unknown>;
}

export type ProviderEvent =
  | { type: 'text'; text: string }
  | { type: 'tool-call'; call: ToolCall }
  | { type: 'done'; finishReason: 'stop' | 'tool-calls' | 'length' | 'error'; error?: string };

export interface GenerateRequest {
  messages: ChatMessage[];
  tools: ToolSpec[];
  signal?: AbortSignal;
}

export interface ProviderAdapter {
  readonly id: string;
  generate(request: GenerateRequest): AsyncIterable<ProviderEvent>;
}
