import { describe, expect, it, vi } from 'vitest';
import {
  InMemorySessionStore,
  InvalidTransition,
  LeaseConflict,
  SessionNotFound,
} from '../src/session-store.js';

function freshSession(origin: 'desktop' | 'server' = 'desktop') {
  const store = new InMemorySessionStore();
  const descriptor = store.create({ workspaceId: 'ws1', devcontainerHash: 'abc123', origin });
  return { store, id: descriptor.sessionId, descriptor };
}

describe('InMemorySessionStore', () => {
  it('creates a local session for a desktop origin', () => {
    const { descriptor } = freshSession();
    expect(descriptor.location).toBe('local');
    expect(descriptor.lease).toBeNull();
  });

  it('throws SessionNotFound for unknown ids', () => {
    expect(() => new InMemorySessionStore().get('nope')).toThrow(SessionNotFound);
  });

  it('runs a full handover: begin → withLease → endTransfer', () => {
    const { store, id } = freshSession();

    const started = store.beginTransfer(id, 'to-server', 'holder');
    expect(started.location).toBe('in-transit');
    expect(started.lease?.etag).toMatch(/^lease-/);

    const rotated = store.withLease(id, started.lease?.etag, (d) => {
      d.webUrl = 'http://ide/1';
    });
    expect(rotated.lease?.etag).not.toBe(started.lease?.etag);

    const done = store.endTransfer(id, 'server');
    expect(done.location).toBe('server');
    expect(done.lease).toBeNull();
    expect(done.webUrl).toBe('http://ide/1');
  });

  it('rejects a second concurrent transfer and a stale If-Match', () => {
    const { store, id } = freshSession();
    store.beginTransfer(id, 'to-server', 'a');
    expect(() => store.beginTransfer(id, 'to-server', 'b')).toThrow(LeaseConflict);
    expect(() => store.withLease(id, 'wrong-etag', () => {})).toThrow(LeaseConflict);
  });

  it('rejects a transfer from the wrong location', () => {
    const { store, id } = freshSession(); // local
    expect(() => store.beginTransfer(id, 'to-local', 'a')).toThrow(InvalidTransition);
  });

  it('abort restores the pre-transfer location', () => {
    const { store, id } = freshSession();
    store.beginTransfer(id, 'to-server', 'a');
    const back = store.abortTransfer(id);
    expect(back.location).toBe('local');
    expect(back.lease).toBeNull();
  });

  it('sweepExpiredLeases auto-aborts and emits lease.expired', () => {
    const { store, id } = freshSession();
    store.beginTransfer(id, 'to-server', 'a');
    const seen = vi.fn();
    store.subscribe(id, seen);

    expect(store.sweepExpiredLeases(Date.now() + 60 * 60_000)).toEqual([id]);
    expect(seen).toHaveBeenCalledWith(expect.objectContaining({ type: 'lease.expired' }));
    expect(store.get(id).location).toBe('local');
  });

  it('emits session.resumed on endTransfer', () => {
    const { store, id } = freshSession();
    store.beginTransfer(id, 'to-server', 'a');
    const seen = vi.fn();
    store.subscribe(id, seen);
    store.endTransfer(id, 'server');
    expect(seen).toHaveBeenCalledWith(expect.objectContaining({ type: 'session.resumed' }));
  });
});
