import { describe, expect, it, vi } from 'vitest';
import { InMemorySessionStore, SessionNotFound } from '../src/session-store.js';

function descriptor(overrides: Partial<Parameters<InMemorySessionStore['upsert']>[0]> = {}) {
  return {
    sessionId: 's1',
    schemaVersion: 2 as const,
    projectName: 'demo',
    phase: 'Running' as const,
    idleTimeoutSeconds: 300,
    lastActivityAt: '2026-01-01T00:00:00Z',
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('InMemorySessionStore', () => {
  it('throws SessionNotFound for unknown ids', () => {
    expect(() => new InMemorySessionStore().get('nope')).toThrow(SessionNotFound);
  });

  it('caches a descriptor on upsert and returns it from get/list', () => {
    const store = new InMemorySessionStore();
    store.upsert(descriptor());
    expect(store.get('s1').phase).toBe('Running');
    expect(store.list()).toHaveLength(1);
  });

  it('overwrites the cached descriptor on a second upsert', () => {
    const store = new InMemorySessionStore();
    store.upsert(descriptor());
    store.upsert(descriptor({ phase: 'Suspended' }));
    expect(store.get('s1').phase).toBe('Suspended');
    expect(store.list()).toHaveLength(1);
  });

  it('removes a session from the cache', () => {
    const store = new InMemorySessionStore();
    store.upsert(descriptor());
    store.remove('s1');
    expect(() => store.get('s1')).toThrow(SessionNotFound);
  });

  it('publishes events to subscribers and supports unsubscribe', () => {
    const store = new InMemorySessionStore();
    store.upsert(descriptor());
    const seen = vi.fn();
    const unsubscribe = store.subscribe('s1', seen);

    store.publish('s1', { type: 'session.phase-changed', sessionId: 's1', phase: 'Suspended' });
    expect(seen).toHaveBeenCalledWith({ type: 'session.phase-changed', sessionId: 's1', phase: 'Suspended' });

    unsubscribe();
    store.publish('s1', { type: 'session.terminated', sessionId: 's1' });
    expect(seen).toHaveBeenCalledOnce();
  });

  it('throws SessionNotFound when subscribing to an uncached session', () => {
    const store = new InMemorySessionStore();
    expect(() => store.subscribe('nope', vi.fn())).toThrow(SessionNotFound);
  });
});
