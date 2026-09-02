import { describe, expect, it } from 'vitest';
import {
  RecentProjectsStore,
  sortRecent,
  upsertRecent,
  type KeyValueStore,
  type RecentProject,
} from '../src/recent-projects.js';

const p = (over: Partial<RecentProject>): RecentProject => ({
  hostPath: '/w/a',
  name: 'a',
  hash: 'h-a',
  serverPort: 8000,
  lastOpenedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

function memory(): KeyValueStore & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get: <T>(k: string) => data.get(k) as T | undefined,
    update: async (k, v) => void data.set(k, v),
  };
}

describe('sortRecent / upsertRecent', () => {
  it('sorts newest first', () => {
    const sorted = sortRecent([
      p({ hash: 'old', lastOpenedAt: '2026-01-01T00:00:00.000Z' }),
      p({ hash: 'new', lastOpenedAt: '2026-06-01T00:00:00.000Z' }),
    ]);
    expect(sorted.map((x) => x.hash)).toEqual(['new', 'old']);
  });

  it('de-dupes by hash and caps', () => {
    const start = [p({ hash: 'h-a' }), p({ hash: 'h-b' })];
    const merged = upsertRecent(start, p({ hash: 'h-a', name: 'renamed', lastOpenedAt: '2027-01-01T00:00:00.000Z' }), 2);
    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({ hash: 'h-a', name: 'renamed' });
  });
});

describe('RecentProjectsStore', () => {
  it('remember → list (newest first), forget, find', async () => {
    const store = new RecentProjectsStore(memory());
    await store.remember({ hostPath: '/w/a', name: 'a', hash: 'h-a', serverPort: 8000 });
    await new Promise((r) => setTimeout(r, 2));
    await store.remember({ hostPath: '/w/b', name: 'b', hash: 'h-b', serverPort: 8000 });

    expect(store.list().map((x) => x.hash)).toEqual(['h-b', 'h-a']);
    expect(store.find('h-a')?.hostPath).toBe('/w/a');

    await store.forget('h-b');
    expect(store.list().map((x) => x.hash)).toEqual(['h-a']);
  });

  it('prune drops entries whose folder is gone', async () => {
    const mem = memory();
    mem.data.set('osiris.recentProjects', [p({ hash: 'gone', hostPath: '/missing' }), p({ hash: 'here', hostPath: '/here' })]);
    const store = new RecentProjectsStore(mem);

    const kept = await store.prune((path) => path === '/here');
    expect(kept.map((x) => x.hash)).toEqual(['here']);
    expect(store.list()).toHaveLength(1);
  });
});
