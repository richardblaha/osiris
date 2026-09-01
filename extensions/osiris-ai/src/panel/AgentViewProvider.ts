import * as vscode from 'vscode';
import { createTelemetry, type TelemetryReporter } from '@osiris/shared-core';
import { AgentOrchestrator } from '../agent/orchestrator.js';
import type { ProviderAdapter } from '../agent/types.js';
import { builtinTools } from '../tools/builtins.js';
import type { McpRegistry } from '../mcp/registry.js';
import type { PanelInbound, PanelOutbound } from '../protocol.js';

export interface AgentViewDeps {
  makeProvider(): ProviderAdapter;
  registry: McpRegistry;
  reloadMcp(): Promise<void>;
  maxIterations(): number;
  systemPrompt(): string;
}

/** Hosts the React agent panel and drives the orchestrator from its messages. */
export class AgentViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'osiris-ai.panel';

  private view?: vscode.WebviewView;
  private abort?: AbortController;
  private busy = false;
  private readonly telemetry: TelemetryReporter;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly deps: AgentViewDeps,
  ) {
    this.telemetry = createTelemetry({ env: process.env });
    context.subscriptions.push({ dispose: () => this.telemetry.dispose() });
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
    };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((msg: PanelInbound) => void this.onMessage(msg));
  }

  focus(): void {
    void vscode.commands.executeCommand(`${AgentViewProvider.viewId}.focus`);
  }

  /** Public entry point for the `osiris-ai.runAgent` command. */
  async runPrompt(prompt: string): Promise<void> {
    this.focus();
    await this.onMessage({ type: 'user/send', prompt });
  }

  private post(message: PanelOutbound): void {
    void this.view?.webview.postMessage(message);
  }

  private sendState(): void {
    this.post({
      type: 'state',
      busy: this.busy,
      mcp: this.deps.registry.status(),
      tools: [
        ...builtinTools().map((t) => t.name),
        ...this.deps.registry.asTools().map((t) => t.name),
      ],
      provider: this.deps.makeProvider().id,
    });
  }

  private async onMessage(msg: PanelInbound): Promise<void> {
    switch (msg.type) {
      case 'ready':
        this.sendState();
        return;
      case 'cancel':
        this.abort?.abort();
        return;
      case 'reloadMcp':
        await this.deps.reloadMcp();
        this.sendState();
        return;
      case 'user/send':
        await this.execute(msg.prompt);
        return;
      default:
        return;
    }
  }

  private async execute(prompt: string): Promise<void> {
    if (this.busy || !prompt.trim()) {
      return;
    }
    this.busy = true;
    this.abort = new AbortController();
    const runId = `run_${Date.now()}`;
    this.sendState();
    this.post({ type: 'agent/run-started', runId, prompt });
    this.telemetry.event({ name: 'ai.run', properties: { provider: this.deps.makeProvider().id } });

    const orchestrator = new AgentOrchestrator(this.deps.makeProvider());
    orchestrator.setTools([...builtinTools(), ...this.deps.registry.asTools()]);

    try {
      const result = await orchestrator.run({
        prompt,
        system: this.deps.systemPrompt(),
        maxIterations: this.deps.maxIterations(),
        signal: this.abort.signal,
        events: {
          onText: (text) => this.post({ type: 'agent/token', runId, text }),
          onToolCall: (call) =>
            this.post({ type: 'agent/tool', runId, name: call.name, input: call.input }),
          onToolResult: (call, res, isError) =>
            this.post({
              type: 'agent/tool',
              runId,
              name: call.name,
              input: call.input,
              result: typeof res === 'string' ? res : JSON.stringify(res),
              isError,
            }),
        },
      });
      this.post({
        type: 'agent/run-finished',
        runId,
        finishReason: result.finishReason,
        error: result.error,
      });
    } catch (cause) {
      this.post({
        type: 'agent/run-finished',
        runId,
        finishReason: 'error',
        error: (cause as Error).message,
      });
      this.telemetry.exception(cause as Error);
    } finally {
      this.busy = false;
      this.abort = undefined;
      this.sendState();
    }
  }

  private html(webview: vscode.Webview): string {
    const nonce = getNonce();
    const script = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'panel.js'),
    );
    const style = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'panel.css'),
    );
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <link rel="stylesheet" href="${style}" />
  <title>Osiris Agent</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
