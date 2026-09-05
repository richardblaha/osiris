/** Message protocol between the extension host and the Agent panel webview. */
import type { McpRegistryStatus } from '@richardblaha/mcp';

export type PanelInbound =
  | { type: 'ready' }
  | { type: 'user/send'; prompt: string }
  | { type: 'cancel' }
  | { type: 'reloadMcp' };

export type PanelOutbound =
  | { type: 'state'; busy: boolean; mcp: McpRegistryStatus[]; tools: string[]; provider: string }
  | { type: 'agent/run-started'; runId: string; prompt: string }
  | { type: 'agent/token'; runId: string; text: string }
  | {
      type: 'agent/tool';
      runId: string;
      name: string;
      input: unknown;
      result?: string;
      isError?: boolean;
    }
  | { type: 'agent/run-finished'; runId: string; finishReason: string; error?: string };
