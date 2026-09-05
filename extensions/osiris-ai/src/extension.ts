import * as vscode from 'vscode';
import { createLogger, type McpServerConfig } from '@richardblaha/shared-core';
import {
  AnthropicAdapter,
  EchoProviderAdapter,
  OllamaAdapter,
  OpenAiCompatibleAdapter,
  type ProviderAdapter,
} from '@richardblaha/agent-core';
import { McpRegistry } from '@richardblaha/mcp';
import { AgentViewProvider } from './panel/AgentViewProvider.js';

const log = createLogger('ai');

const SYSTEM_PROMPT =
  'You are the Osiris agent, embedded in the Osiris IDE. Use the available workspace ' +
  'and MCP tools to help the user. Be concise. Prefer tool calls over guessing.';

function config() {
  return vscode.workspace.getConfiguration('osiris-ai');
}

function ollamaUrl(): string {
  return (
    config().get<string>('ollamaUrl', '').trim() ||
    process.env.OSIRIS_OLLAMA_URL ||
    'http://localhost:11434'
  );
}

/** The `osiris.models.chat` spec from the onboarding wizard, if set. */
function chatSpec(): string {
  return vscode.workspace.getConfiguration('osiris.models').get<string>('chat', '').trim();
}

function usesOllama(): boolean {
  return (
    chatSpec().startsWith('ollama/') || config().get<string>('provider', 'ollama') === 'ollama'
  );
}

/** Set by {@link probeOllama}; the ollama path falls back to echo while false. */
let ollamaReachable = false;

async function probeOllama(): Promise<void> {
  if (!usesOllama()) return;
  try {
    const res = await fetch(`${ollamaUrl().replace(/\/$/, '')}/api/tags`);
    ollamaReachable = res.ok;
  } catch {
    ollamaReachable = false;
  }
  if (!ollamaReachable) {
    void vscode.window.showWarningMessage(
      `Osiris AI: the chat model runs on Ollama but ${ollamaUrl()} is unreachable; falling back to the echo provider.`,
    );
  }
}

/** Build an adapter from a `<provider>/<model>` spec (the wizard's `osiris.models.chat`). */
function adapterForSpec(spec: string): ProviderAdapter | undefined {
  const m = /^([\w-]+)\/([\w.:-]+)$/.exec(spec);
  if (!m) return undefined;
  const [, provider, model] = m as unknown as [string, string, string];
  switch (provider) {
    case 'ollama':
      return ollamaReachable
        ? new OllamaAdapter({ baseUrl: ollamaUrl(), model })
        : new EchoProviderAdapter();
    case 'anthropic':
      return new AnthropicAdapter({ model }); // SDK reads ANTHROPIC_API_KEY from the env
    case 'openai-compatible': {
      const endpoint = config().get<string>('endpoint', '').trim();
      if (!endpoint) return undefined;
      return new OpenAiCompatibleAdapter({
        endpoint,
        model,
        apiKey: process.env[config().get<string>('apiKeyEnv', 'OSIRIS_AI_API_KEY')],
      });
    }
    case 'echo':
      return new EchoProviderAdapter();
    default:
      return undefined; // e.g. vscode-lm — not available to the panel
  }
}

function makeProvider(): ProviderAdapter {
  const spec = chatSpec();
  if (spec) {
    const adapter = adapterForSpec(spec);
    if (adapter) return adapter;
    log.warn('osiris.models.chat "%s" is not usable in the panel; using the legacy provider', spec);
  }

  const kind = config().get<string>('provider', 'ollama');
  if (kind === 'ollama') {
    if (!ollamaReachable) return new EchoProviderAdapter();
    return new OllamaAdapter({
      baseUrl: ollamaUrl(),
      model: config().get<string>('ollamaModel', 'qwen3:4b'),
    });
  }
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
      if (
        e.affectsConfiguration('osiris-ai.provider') ||
        e.affectsConfiguration('osiris-ai.ollamaUrl') ||
        e.affectsConfiguration('osiris.models.chat')
      ) {
        void probeOllama();
      }
    }),
  );

  await Promise.all([reloadMcp(), probeOllama()]);
}

export function deactivate(): void {
  log.info('deactivating osiris-ai');
}
