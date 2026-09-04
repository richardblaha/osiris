import { EventEmitter } from 'node:events';
import type { SessionDescriptor, SessionEvent } from '@osiris/protocol';

export class SessionNotFound extends Error {
  constructor(id: string) {
    super(`session not found: ${id}`);
    this.name = 'SessionNotFound';
  }
}

interface SessionRecord {
  descriptor: SessionDescriptor;
  events: EventEmitter;
}

/**
 * A thin in-process cache + SSE fanout layer. The `OsirisSession` custom
 * resource in the cluster is the durable source of truth (reconciled by
 * osiris-kind-operator) — this store only mirrors the latest known
 * descriptor per session (`upsert`, called after every executor call and by
 * the Kubernetes informer on any status change) and lets `GET .../events`
 * subscribe to per-session updates without every browser tab managing its
 * own K8s watch.
 */
export interface SessionStore {
  /** Cache the latest known descriptor for a session. */
  upsert(descriptor: SessionDescriptor): void;
  get(id: string): SessionDescriptor;
  list(): SessionDescriptor[];
  /** Drop a session from the cache (after it's been deleted in the cluster). */
  remove(id: string): void;
  /** Subscribe to a session's event stream; returns an unsubscribe fn. */
  subscribe(id: string, listener: (event: SessionEvent) => void): () => void;
  /** Publish an event to a session's subscribers. */
  publish(id: string, event: SessionEvent): void;
}

export class InMemorySessionStore implements SessionStore {
  private readonly records = new Map<string, SessionRecord>();

  upsert(descriptor: SessionDescriptor): void {
    const existing = this.records.get(descriptor.sessionId);
    if (existing) {
      existing.descriptor = descriptor;
    } else {
      this.records.set(descriptor.sessionId, { descriptor, events: new EventEmitter() });
    }
  }

  get(id: string): SessionDescriptor {
    return structuredClone(this.record(id).descriptor);
  }

  list(): SessionDescriptor[] {
    return [...this.records.values()].map((r) => structuredClone(r.descriptor));
  }

  remove(id: string): void {
    this.records.delete(id);
  }

  subscribe(id: string, listener: (event: SessionEvent) => void): () => void {
    const { events } = this.record(id);
    events.on('event', listener);
    return () => events.off('event', listener);
  }

  publish(id: string, event: SessionEvent): void {
    this.record(id).events.emit('event', event);
  }

  private record(id: string): SessionRecord {
    const record = this.records.get(id);
    if (!record) throw new SessionNotFound(id);
    return record;
  }
}
