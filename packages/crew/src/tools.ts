import { readFile } from 'node:fs/promises';
import { isAbsolute, join, normalize, relative } from 'node:path';
import type { Tool } from '@osiris/agent-core';
import type { BacklogBoard, BacklogTask } from '@osiris/protocol';

export interface MemoryBridge {
  search(
    query: string,
    k: number,
    source?: string,
  ): Promise<{ document: string; source: string; headingPath: string; score: number }[]>;
}

export interface BacklogBridge {
  board(): Promise<BacklogBoard>;
  task(id: number): Promise<BacklogTask | undefined>;
}

export interface ToolboxDeps {
  /** Workspace root — `read_file` is sandboxed to this. */
  root: string;
  memory?: MemoryBridge;
  backlog?: BacklogBridge;
}

export function memorySearchTool(memory: MemoryBridge): Tool {
  return {
    name: 'memory_search',
    description:
      'Semantic search over the .osiris/memory/ knowledge base. Returns the most relevant passages with their source file.',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string' },
        k: { type: 'number', description: 'max results (default 6)' },
        source: { type: 'string', description: 'restrict to one source file' },
      },
    },
    async invoke(input) {
      const { query, k, source } = (input ?? {}) as { query?: string; k?: number; source?: string };
      if (!query) return 'error: "query" is required';
      const hits = await memory.search(query, k ?? 6, source);
      if (hits.length === 0) return 'No matching passages.';
      return hits
        .map((h, i) => `#${i + 1} (${h.source} · ${h.headingPath || 'top'} · ${h.score.toFixed(2)})\n${h.document}`)
        .join('\n\n---\n\n');
    },
  };
}

export function backlogReadTool(backlog: BacklogBridge): Tool {
  return {
    name: 'backlog_read',
    description:
      'Read the file-based backlog. With no id, returns the board (tasks grouped by state). With an id, returns that task in full.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'number', description: 'a task id; omit for the whole board' } },
    },
    async invoke(input) {
      const { id } = (input ?? {}) as { id?: number };
      if (typeof id === 'number') {
        const task = await backlog.task(id);
        return task ? JSON.stringify(task, null, 2) : `No task with id ${id}.`;
      }
      const board = await backlog.board();
      const byState = board.states.map((state) => {
        const items = board.tasks.filter((t) => t.state === state);
        return `${state} (${items.length})\n${items.map((t) => `  [${t.type}] #${t.id} ${t.title}`).join('\n')}`;
      });
      return `branch: ${board.branch}\n\n${byState.join('\n\n')}`;
    },
  };
}

export function readFileTool(root: string): Tool {
  return {
    name: 'read_file',
    description: 'Read a UTF-8 text file from the workspace. Path is relative to the workspace root.',
    inputSchema: {
      type: 'object',
      required: ['path'],
      properties: { path: { type: 'string' }, maxBytes: { type: 'number' } },
    },
    async invoke(input) {
      const { path, maxBytes } = (input ?? {}) as { path?: string; maxBytes?: number };
      if (!path) return 'error: "path" is required';
      const abs = normalize(isAbsolute(path) ? path : join(root, path));
      const rel = relative(root, abs);
      if (rel.startsWith('..') || isAbsolute(rel)) return 'error: path escapes the workspace root';
      try {
        const content = await readFile(abs, 'utf8');
        const limit = maxBytes ?? 64_000;
        return content.length > limit ? `${content.slice(0, limit)}\n… [truncated]` : content;
      } catch (cause) {
        return `error: ${(cause as Error).message}`;
      }
    },
  };
}

/** All bridge tools available to the crew, keyed by tool name. */
export function buildToolbox(deps: ToolboxDeps): Map<string, Tool> {
  const tools: Tool[] = [readFileTool(deps.root)];
  if (deps.memory) tools.push(memorySearchTool(deps.memory));
  if (deps.backlog) tools.push(backlogReadTool(deps.backlog));
  return new Map(tools.map((t) => [t.name, t]));
}
