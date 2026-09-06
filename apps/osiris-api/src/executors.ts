import { randomUUID } from 'node:crypto';
import {
  SESSION_SCHEMA_VERSION,
  type CreateSessionRequest,
  type SessionDescriptor,
} from '@richardblaha/osiris-protocol';

export class SessionNotFoundInExecutor extends Error {
  constructor(id: string) {
    super(`session not found: ${id}`);
    this.name = 'SessionNotFoundInExecutor';
  }
}

const DEFAULT_IDLE_TIMEOUT_SECONDS = 300;

/**
 * The infrastructure side of session lifecycle: create/suspend/resume/delete
 * a session and report user activity against it. {@link StubSessionExecutor}
 * lets the API and routing logic run without a cluster;
 * {@link KubernetesSessionExecutor} (see `kubernetes-executor.ts`) is the
 * real implementation, backed by the `osiris-kind-operator`'s
 * `OsirisSession` custom resource.
 */
export interface SessionExecutor {
  createSession(input: CreateSessionRequest): Promise<SessionDescriptor>;
  getSession(sessionId: string): Promise<SessionDescriptor>;
  suspendSession(sessionId: string): Promise<SessionDescriptor>;
  resumeSession(sessionId: string): Promise<SessionDescriptor>;
  deleteSession(sessionId: string): Promise<void>;
  reportActivity(sessionId: string): Promise<void>;
}

/** In-memory stand-in for local dev and tests — no cluster required. */
export class StubSessionExecutor implements SessionExecutor {
  private readonly sessions = new Map<string, SessionDescriptor>();

  async createSession(input: CreateSessionRequest): Promise<SessionDescriptor> {
    const now = new Date().toISOString();
    const descriptor: SessionDescriptor = {
      sessionId: randomUUID(),
      schemaVersion: SESSION_SCHEMA_VERSION,
      projectName: input.projectName,
      phase: 'Running',
      idleTimeoutSeconds: input.idleTimeoutSeconds ?? DEFAULT_IDLE_TIMEOUT_SECONDS,
      lastActivityAt: now,
      createdAt: now,
    };
    this.sessions.set(descriptor.sessionId, descriptor);
    return structuredClone(descriptor);
  }

  async getSession(sessionId: string): Promise<SessionDescriptor> {
    return structuredClone(this.record(sessionId));
  }

  async suspendSession(sessionId: string): Promise<SessionDescriptor> {
    const descriptor = this.record(sessionId);
    descriptor.phase = 'Suspended';
    return structuredClone(descriptor);
  }

  async resumeSession(sessionId: string): Promise<SessionDescriptor> {
    const descriptor = this.record(sessionId);
    descriptor.phase = 'Running';
    descriptor.lastActivityAt = new Date().toISOString();
    return structuredClone(descriptor);
  }

  async deleteSession(sessionId: string): Promise<void> {
    if (!this.sessions.delete(sessionId)) throw new SessionNotFoundInExecutor(sessionId);
  }

  async reportActivity(sessionId: string): Promise<void> {
    const descriptor = this.record(sessionId);
    descriptor.lastActivityAt = new Date().toISOString();
    if (descriptor.phase === 'Suspended') descriptor.phase = 'Running';
  }

  private record(sessionId: string): SessionDescriptor {
    const descriptor = this.sessions.get(sessionId);
    if (!descriptor) throw new SessionNotFoundInExecutor(sessionId);
    return descriptor;
  }
}
