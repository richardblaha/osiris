import * as vscode from 'vscode';
import type { Tool } from '@osiris/agent-core';

/** A small set of always-available workspace tools for the agent. */
export function builtinTools(): Tool[] {
  return [
    {
      name: 'workspace.listFiles',
      description:
        'List workspace files matching a glob pattern (default: all files, capped at 200).',
      inputSchema: {
        type: 'object',
        properties: {
          glob: { type: 'string', description: 'Glob pattern, e.g. "src/**/*.ts"' },
          maxResults: { type: 'number' },
        },
      },
      invoke: async (input) => {
        const { glob = '**/*', maxResults = 200 } = (input ?? {}) as {
          glob?: string;
          maxResults?: number;
        };
        const uris = await vscode.workspace.findFiles(glob, '**/node_modules/**', maxResults);
        return uris.map((u) => vscode.workspace.asRelativePath(u)).join('\n');
      },
    },
    {
      name: 'workspace.readFile',
      description: 'Read a UTF-8 text file from the workspace by relative path.',
      inputSchema: {
        type: 'object',
        required: ['path'],
        properties: { path: { type: 'string' } },
      },
      invoke: async (input) => {
        const { path } = (input ?? {}) as { path?: string };
        if (!path) {
          throw new Error('path is required');
        }
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder) {
          throw new Error('no workspace folder is open');
        }
        const uri = vscode.Uri.joinPath(folder.uri, path);
        const bytes = await vscode.workspace.fs.readFile(uri);
        const text = Buffer.from(bytes).toString('utf8');
        return text.length > 20000 ? `${text.slice(0, 20000)}\n…(truncated)` : text;
      },
    },
    {
      name: 'workspace.showMessage',
      description: 'Show an information message to the user in the IDE.',
      inputSchema: {
        type: 'object',
        required: ['message'],
        properties: { message: { type: 'string' } },
      },
      invoke: async (input) => {
        const { message } = (input ?? {}) as { message?: string };
        await vscode.window.showInformationMessage(`Osiris AI: ${message ?? ''}`);
        return 'shown';
      },
    },
  ];
}
