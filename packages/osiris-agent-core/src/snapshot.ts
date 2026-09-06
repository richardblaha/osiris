/**
 * The portable agent state written into `/<workspace>/.osiris/` so it travels
 * with the workspace volume during a session handover. API keys are never part
 * of a snapshot — they are re-injected from the host/server keychain on resume.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ChatMessage } from './types.js';

export const AGENT_SNAPSHOT_VERSION = 1 as const;

export type SnapshotProviderName = 'anthropic' | 'openai' | 'mistral' | 'ollama' | 'echo';

export type TaskStatus = 'pending' | 'running' | 'blocked' | 'done';

export interface AgentTask {
  id: string;
  title: string;
  status: TaskStatus;
  /** Where to resume the task after a migration. */
  cursor?: string;
  parentId?: string;
}

export interface WorkingSetEntry {
  path: string;
  hash: string;
  pinned: boolean;
}

export interface AgentSnapshot {
  meta: {
    sessionId: string;
    schemaVersion: typeof AGENT_SNAPSHOT_VERSION;
    createdAt: string;
    origin: 'desktop' | 'server';
  };
  conversation: ChatMessage[];
  tasks: AgentTask[];
  workingSet: WorkingSetEntry[];
  provider: {
    name: SnapshotProviderName;
    model: string;
    baseUrl?: string;
  };
}

export interface SnapshotStore {
  read(): Promise<AgentSnapshot | undefined>;
  write(snapshot: AgentSnapshot): Promise<void>;
}

export interface CreateSnapshotInit {
  sessionId: string;
  origin: 'desktop' | 'server';
  provider: AgentSnapshot['provider'];
  conversation?: ChatMessage[];
  tasks?: AgentTask[];
  workingSet?: WorkingSetEntry[];
}

export function createSnapshot(init: CreateSnapshotInit): AgentSnapshot {
  return {
    meta: {
      sessionId: init.sessionId,
      schemaVersion: AGENT_SNAPSHOT_VERSION,
      createdAt: new Date().toISOString(),
      origin: init.origin,
    },
    conversation: init.conversation ?? [],
    tasks: init.tasks ?? [],
    workingSet: init.workingSet ?? [],
    provider: init.provider,
  };
}

/** Tasks the agent should pick back up after a resume, in declaration order. */
export function pendingTasks(snapshot: AgentSnapshot): AgentTask[] {
  return snapshot.tasks.filter((task) => task.status === 'pending' || task.status === 'running');
}

/** In-memory store for tests and ephemeral sessions. */
export class MemorySnapshotStore implements SnapshotStore {
  private snapshot?: AgentSnapshot;

  constructor(initial?: AgentSnapshot) {
    this.snapshot = initial;
  }

  async read(): Promise<AgentSnapshot | undefined> {
    return this.snapshot;
  }

  async write(snapshot: AgentSnapshot): Promise<void> {
    this.snapshot = structuredClone(snapshot);
  }
}

/** JSON-file store — the default for a workspace snapshot at `.osiris/agent-state.json`. */
export class JsonSnapshotStore implements SnapshotStore {
  constructor(private readonly filePath: string) {}

  async read(): Promise<AgentSnapshot | undefined> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      return JSON.parse(raw) as AgentSnapshot;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw cause;
    }
  }

  async write(snapshot: AgentSnapshot): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
    await rename(tmp, this.filePath);
  }
}
