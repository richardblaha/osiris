import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  SessionDescriptor,
  SessionEvent,
  SessionLocation,
  SessionOrigin,
  TransferDirection,
} from '@osiris/protocol';
import { isLeaseExpired, leaseExpiresAt, newLeaseEtag } from './lease.js';

export class SessionNotFound extends Error {
  constructor(id: string) {
    super(`session not found: ${id}`);
    this.name = 'SessionNotFound';
  }
}

export class LeaseConflict extends Error {
  constructor(reason: string) {
    super(`lease conflict: ${reason}`);
    this.name = 'LeaseConflict';
  }
}

export class InvalidTransition extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'InvalidTransition';
  }
}

interface SessionRecord {
  descriptor: SessionDescriptor;
  /** Location to restore to if the in-flight transfer aborts or its lease expires. */
  previousLocation: SessionLocation;
  events: EventEmitter;
}

/** The durable part of a {@link SessionRecord} — event emitters stay in-process. */
export interface PersistedSession {
  descriptor: SessionDescriptor;
  previousLocation: SessionLocation;
}

/** Reload/persist the session table across process restarts. */
export interface SessionPersistence {
  load(): PersistedSession[];
  save(sessions: PersistedSession[]): void;
}

export interface CreateSessionInput {
  workspaceId: string;
  devcontainerHash: string;
  origin: SessionOrigin;
}

/** Where a session runs and the digests of its last successful transfer. */
export interface SessionStore {
  create(input: CreateSessionInput): SessionDescriptor;
  get(id: string): SessionDescriptor;
  list(): SessionDescriptor[];
  /** Subscribe to a session's event stream; returns an unsubscribe fn. */
  subscribe(id: string, listener: (event: SessionEvent) => void): () => void;

  /** Acquire the exclusive transfer lease and move to `in-transit`. */
  beginTransfer(id: string, direction: TransferDirection, holder: string): SessionDescriptor;
  /** Verify `ifMatch` against the live lease etag, apply `mutate`, rotate the etag. */
  withLease(
    id: string,
    ifMatch: string | undefined,
    mutate: (descriptor: SessionDescriptor) => void,
  ): SessionDescriptor;
  /** Release the lease and land on `location`. */
  endTransfer(id: string, location: SessionLocation): SessionDescriptor;
  /** Abort: release the lease and restore the pre-transfer location. */
  abortTransfer(id: string): SessionDescriptor;
  /** Auto-abort every session whose lease has expired; returns the affected ids. */
  sweepExpiredLeases(now?: number): string[];
  /** Publish an event to a session's subscribers. */
  publish(id: string, event: SessionEvent): void;
}

export class InMemorySessionStore implements SessionStore {
  private readonly records = new Map<string, SessionRecord>();

  constructor(private readonly persistence?: SessionPersistence) {
    for (const { descriptor, previousLocation } of persistence?.load() ?? []) {
      this.records.set(descriptor.sessionId, {
        descriptor,
        previousLocation,
        events: new EventEmitter(),
      });
    }
  }

  /** Write the durable session table out after a mutation. */
  private flush(): void {
    if (!this.persistence) return;
    this.persistence.save(
      [...this.records.values()].map((r) => ({
        descriptor: r.descriptor,
        previousLocation: r.previousLocation,
      })),
    );
  }

  create(input: CreateSessionInput): SessionDescriptor {
    const sessionId = randomUUID();
    const descriptor: SessionDescriptor = {
      sessionId,
      schemaVersion: 1,
      location: input.origin === 'server' ? 'server' : 'local',
      origin: input.origin,
      workspaceId: input.workspaceId,
      devcontainerHash: input.devcontainerHash,
      lease: null,
    };
    this.records.set(sessionId, {
      descriptor,
      previousLocation: descriptor.location,
      events: new EventEmitter(),
    });
    this.flush();
    return structuredClone(descriptor);
  }

  get(id: string): SessionDescriptor {
    return structuredClone(this.record(id).descriptor);
  }

  list(): SessionDescriptor[] {
    return [...this.records.values()].map((r) => structuredClone(r.descriptor));
  }

  subscribe(id: string, listener: (event: SessionEvent) => void): () => void {
    const { events } = this.record(id);
    events.on('event', listener);
    return () => events.off('event', listener);
  }

  beginTransfer(id: string, direction: TransferDirection, holder: string): SessionDescriptor {
    const record = this.record(id);
    const { descriptor } = record;

    if (descriptor.lease) {
      throw new LeaseConflict('a transfer is already in progress');
    }
    const expected: SessionLocation = direction === 'to-server' ? 'local' : 'server';
    if (descriptor.location !== expected) {
      throw new InvalidTransition(
        `cannot start a ${direction} transfer from "${descriptor.location}"`,
      );
    }

    record.previousLocation = descriptor.location;
    descriptor.lease = { etag: newLeaseEtag(), holder, expiresAt: leaseExpiresAt() };
    descriptor.location = 'in-transit';
    descriptor.transfer = { direction, startedAt: new Date().toISOString() };
    this.flush();
    return structuredClone(descriptor);
  }

  withLease(
    id: string,
    ifMatch: string | undefined,
    mutate: (descriptor: SessionDescriptor) => void,
  ): SessionDescriptor {
    const record = this.record(id);
    const { descriptor } = record;

    if (!descriptor.lease) {
      throw new LeaseConflict('no transfer is in progress');
    }
    if (ifMatch !== descriptor.lease.etag) {
      throw new LeaseConflict('If-Match does not match the current lease');
    }
    if (isLeaseExpired(descriptor.lease.expiresAt)) {
      this.restore(record);
      throw new LeaseConflict('the transfer lease has expired');
    }

    mutate(descriptor);
    descriptor.lease = { ...descriptor.lease, etag: newLeaseEtag(), expiresAt: leaseExpiresAt() };
    this.flush();
    return structuredClone(descriptor);
  }

  endTransfer(id: string, location: SessionLocation): SessionDescriptor {
    const record = this.record(id);
    record.descriptor.location = location;
    record.descriptor.lease = null;
    delete record.descriptor.transfer;
    this.flush();
    const snapshot = structuredClone(record.descriptor);
    this.emit(record, { type: 'session.resumed', sessionId: id, descriptor: snapshot });
    return snapshot;
  }

  abortTransfer(id: string): SessionDescriptor {
    const snapshot = this.restore(this.record(id));
    this.flush();
    return snapshot;
  }

  sweepExpiredLeases(now: number = Date.now()): string[] {
    const expired: string[] = [];
    for (const [id, record] of this.records) {
      const { lease } = record.descriptor;
      if (lease && isLeaseExpired(lease.expiresAt, now)) {
        this.restore(record);
        this.emit(record, { type: 'lease.expired', sessionId: id });
        expired.push(id);
      }
    }
    if (expired.length) this.flush();
    return expired;
  }

  /** Publish an event to a session's subscribers (used by route handlers). */
  publish(id: string, event: SessionEvent): void {
    this.emit(this.record(id), event);
  }

  private restore(record: SessionRecord): SessionDescriptor {
    record.descriptor.location = record.previousLocation;
    record.descriptor.lease = null;
    delete record.descriptor.transfer;
    return structuredClone(record.descriptor);
  }

  private emit(record: SessionRecord, event: SessionEvent): void {
    record.events.emit('event', event);
  }

  private record(id: string): SessionRecord {
    const record = this.records.get(id);
    if (!record) throw new SessionNotFound(id);
    return record;
  }
}

/** JSON-file persistence — one `sessions.json` in `dir`, written atomically. */
export function fileSessionPersistence(dir: string): SessionPersistence {
  const file = join(dir, 'sessions.json');
  return {
    load() {
      if (!existsSync(file)) return [];
      try {
        return JSON.parse(readFileSync(file, 'utf8')) as PersistedSession[];
      } catch {
        return [];
      }
    },
    save(sessions) {
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(sessions, null, 2)}\n`, 'utf8');
      renameSync(tmp, file);
    },
  };
}

/** Session store that survives a server restart by persisting to `<dir>/sessions.json`. */
export class FileSessionStore extends InMemorySessionStore {
  constructor(dir: string) {
    super(fileSessionPersistence(dir));
  }
}
