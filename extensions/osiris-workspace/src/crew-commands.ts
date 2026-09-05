import * as vscode from 'vscode';
import { ConsoleClient, type CrewEvent } from '@richardblaha/protocol';
import { createLogger } from '@richardblaha/shared-core';

const log = createLogger('workspace:crew');

function config() {
  return vscode.workspace.getConfiguration('osiris');
}

/** Base URL of the osiris-server that hosts the crew/backlog/memory API. */
function serverBaseUrl(): string {
  return config().get<string>('server.url')?.replace(/\/+$/, '') || 'http://localhost:8080';
}

function serverToken(): string | undefined {
  const key = config().get<string>('server.tokenEnv', 'OSIRIS_SERVER_TOKEN');
  return key ? process.env[key] : undefined;
}

function client(): ConsoleClient {
  return new ConsoleClient({ baseUrl: serverBaseUrl(), token: serverToken() });
}

function describe(e: CrewEvent): string {
  switch (e.type) {
    case 'agent.start':
      return `\n▸ ${e.agent} (depth ${e.depth})\n  brief: ${e.brief}`;
    case 'agent.text':
      return e.text;
    case 'agent.tool':
      return `\n  · ${e.agent} uses ${e.tool}`;
    case 'delegate':
      return `\n  ↳ ${e.from} → ${e.to}: ${e.brief}`;
    case 'blackboard':
      return `\n  [${e.entry.kind}] ${e.entry.agent}: ${e.entry.text}`;
    case 'agent.finish':
      return `\n✓ ${e.agent} done`;
    case 'run.finish':
      return `\n\n── ${e.result.finishReason} · ${e.result.delegations.length} delegation(s) ──\n${e.result.text || e.result.error || ''}\n`;
    default:
      return '';
  }
}

let channel: vscode.OutputChannel | undefined;
function output(): vscode.OutputChannel {
  channel ??= vscode.window.createOutputChannel('Osiris Crew');
  return channel;
}

/** Prompt for a task, run the crew on the osiris-server, stream events to an output channel. */
export async function runCrew(): Promise<void> {
  const api = client();

  let agents: { name: string; role: string }[] = [];
  try {
    agents = await api.agents();
  } catch (cause) {
    void vscode.window.showErrorMessage(
      `Osiris: can't reach the server at ${serverBaseUrl()} (${(cause as Error).message}). Set "osiris.server.url" or run \`osiris serve\`.`,
    );
    return;
  }

  const task = await vscode.window.showInputBox({
    title: 'Osiris Crew — task',
    placeHolder: 'e.g. add a foo parser with tests',
    ignoreFocusOut: true,
  });
  if (!task?.trim()) return;

  const leadPick = await vscode.window.showQuickPick(
    [
      { label: 'default (crew.json lead)', description: '', name: undefined as string | undefined },
      ...agents.map((a) => ({ label: a.name, description: a.role, name: a.name })),
    ],
    { title: 'Lead agent' },
  );
  if (!leadPick) return;

  const out = output();
  out.clear();
  out.show(true);
  out.appendLine(`$ osiris crew run "${task}"${leadPick.name ? ` --lead ${leadPick.name}` : ''}`);

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Osiris Crew running…',
      cancellable: false,
    },
    async () => {
      try {
        for await (const event of api.run$({ task: task.trim(), lead: leadPick.name })) {
          out.append(describe(event));
        }
      } catch (cause) {
        out.appendLine(`\nerror: ${(cause as Error).message}`);
        log.error('crew run failed: %s', (cause as Error).message);
      }
    },
  );
}

/** Open the Osiris console (Kanban / crew / memory) in the Simple Browser. */
export async function openConsole(): Promise<void> {
  const url = serverBaseUrl();
  try {
    await vscode.commands.executeCommand('simpleBrowser.show', url);
  } catch {
    await vscode.env.openExternal(vscode.Uri.parse(url));
  }
}
