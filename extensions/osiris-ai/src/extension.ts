import * as vscode from 'vscode';
import { createLogger, type McpServerConfig } from '@osiris/shared-core';
import { EchoProviderAdapter, OpenAiCompatibleAdapter } from './agent/providers.js';
import type { ProviderAdapter } from './agent/types.js';
import { McpRegistry } from './mcp/registry.js';
import { AgentViewProvider } from './panel/AgentViewProvider.js';

const log = createLogger('ai');

const SYSTEM_PROMPT =
  'You are the Osiris agent, embedded in the Osiris IDE. Use the available workspace ' +
  'and MCP tools to help the user. Be concise. Prefer tool calls over guessing.';

function config() {
  return vscode.workspace.getConfiguration('osiris-ai');
}

function makeProvider(): ProviderAdapter {
  const kind = config().get<string>('provider', 'echo');
  if (kind === 'openai-compatible') {
    const endpoint = config().get<string>('endpoint', '').trim();
    if (!endpoint) {
      void vscode.window.showWarningMessage(
        'osiris-ai.provider is "openai-compatible" but osiris-ai.endpoint is empty; falling back to the echo provider.',
      );
      return new EchoProviderAdapter();
    }
    const apiKeyEnv = config().get<string>('apiKeyEnv', 'OSIRIS_AI_API_KEY');
    return new OpenAiCompatibleAdapter({
      endpoint,
      model: config().get<string>('model', ''),
      apiKey: process.env[apiKeyEnv],
    });
  }
  return new EchoProviderAdapter();
}

function readMcpConfigs(): McpServerConfig[] {
  return config().get<McpServerConfig[]>('mcpServers', []) ?? [];
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  log.info('activating osiris-ai');
  const registry = new McpRegistry();
  context.subscriptions.push({ dispose: () => void registry.disposeAll() });

  const reloadMcp = async (): Promise<void> => {
    await registry.load(readMcpConfigs());
    const failed = registry.status().filter((s) => s.error);
    if (failed.length) {
      void vscode.window.showWarningMessage(
        `Osiris AI: ${failed.length} MCP server(s) failed to start: ${failed.map((s) => s.id).join(', ')}`,
      );
    }
  };

  const provider = new AgentViewProvider(context, {
    makeProvider,
    registry,
    reloadMcp,
    maxIterations: () => config().get<number>('maxIterations', 8),
    systemPrompt: () => SYSTEM_PROMPT,
  });

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(AgentViewProvider.viewId, provider),

    vscode.commands.registerCommand('osiris-ai.openPanel', () => provider.focus()),

    vscode.commands.registerCommand('osiris-ai.runAgent', async () => {
      const prompt = await vscode.window.showInputBox({
        prompt: 'Prompt for the Osiris agent',
        placeHolder: 'e.g. list the TypeScript files under src and summarise extension.ts',
      });
      if (prompt) {
        await provider.runPrompt(prompt);
      }
    }),

    vscode.commands.registerCommand('osiris-ai.reloadMcp', reloadMcp),

    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('osiris-ai.mcpServers')) {
        void reloadMcp();
      }
    }),
  );

  await reloadMcp();
}

export function deactivate(): void {
  log.info('deactivating osiris-ai');
}
