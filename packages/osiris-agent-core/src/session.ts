/**
 * Ties the agent loop to a durable snapshot. `AgentSession` owns the current
 * `AgentSnapshot`, records each completed turn into it and persists on demand —
 * so a handover can freeze the workspace and a resume can continue mid-task.
 */
import {
  createSnapshot,
  pendingTasks,
  type AgentSnapshot,
  type AgentTask,
  type CreateSnapshotInit,
  type SnapshotStore,
  type TaskStatus,
} from './snapshot.js';
import type { ChatMessage } from './types.js';

export class AgentSession {
  private constructor(
    private readonly store: SnapshotStore,
    private snapshot: AgentSnapshot,
  ) {}

  static create(store: SnapshotStore, init: CreateSnapshotInit): AgentSession {
    return new AgentSession(store, createSnapshot(init));
  }

  /** Rehydrate from a store; `undefined` if nothing was persisted yet. */
  static async restore(store: SnapshotStore): Promise<AgentSession | undefined> {
    const snapshot = await store.read();
    return snapshot ? new AgentSession(store, snapshot) : undefined;
  }

  get sessionId(): string {
    return this.snapshot.meta.sessionId;
  }

  get conversation(): ChatMessage[] {
    return this.snapshot.conversation;
  }

  get tasks(): AgentTask[] {
    return this.snapshot.tasks;
  }

  pendingTasks(): AgentTask[] {
    return pendingTasks(this.snapshot);
  }

  /** Replace the conversation with the messages a completed run produced. */
  recordTurn(messages: ChatMessage[]): void {
    this.snapshot.conversation = messages;
  }

  addTask(task: AgentTask): void {
    this.snapshot.tasks.push(task);
  }

  updateTask(id: string, patch: Partial<Pick<AgentTask, 'status' | 'cursor'>>): void {
    const task = this.snapshot.tasks.find((t) => t.id === id);
    if (!task) throw new Error(`no such task: ${id}`);
    if (patch.status) task.status = patch.status;
    if ('cursor' in patch) task.cursor = patch.cursor;
  }

  setTaskStatus(id: string, status: TaskStatus): void {
    this.updateTask(id, { status });
  }

  toSnapshot(): AgentSnapshot {
    return structuredClone(this.snapshot);
  }

  /** Refresh `createdAt` and flush to the store — call this to freeze for handover. */
  async persist(): Promise<void> {
    this.snapshot.meta.createdAt = new Date().toISOString();
    await this.store.write(this.snapshot);
  }
}
