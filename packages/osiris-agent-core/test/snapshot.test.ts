import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AGENT_SNAPSHOT_VERSION,
  JsonSnapshotStore,
  MemorySnapshotStore,
  createSnapshot,
  pendingTasks,
} from '../src/snapshot.js';
import { AgentSession } from '../src/session.js';

const provider = { name: 'anthropic' as const, model: 'claude-opus-5' };

describe('createSnapshot', () => {
  it('stamps schema version and origin', () => {
    const snap = createSnapshot({ sessionId: 's1', origin: 'desktop', provider });
    expect(snap.meta.schemaVersion).toBe(AGENT_SNAPSHOT_VERSION);
    expect(snap.meta.origin).toBe('desktop');
    expect(snap.conversation).toEqual([]);
  });
});

describe('pendingTasks', () => {
  it('selects pending and running tasks only', () => {
    const snap = createSnapshot({
      sessionId: 's1',
      origin: 'desktop',
      provider,
      tasks: [
        { id: 'a', title: 'a', status: 'pending' },
        { id: 'b', title: 'b', status: 'done' },
        { id: 'c', title: 'c', status: 'running' },
      ],
    });
    expect(pendingTasks(snap).map((t) => t.id)).toEqual(['a', 'c']);
  });
});

describe('JsonSnapshotStore', () => {
  it('round-trips through a file and returns undefined when absent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'osiris-snap-'));
    const store = new JsonSnapshotStore(join(dir, 'nested', 'agent-state.json'));

    expect(await store.read()).toBeUndefined();

    const snap = createSnapshot({ sessionId: 's7', origin: 'server', provider });
    await store.write(snap);

    const back = await store.read();
    expect(back?.meta.sessionId).toBe('s7');
    const onDisk = await readFile(join(dir, 'nested', 'agent-state.json'), 'utf8');
    expect(onDisk.endsWith('\n')).toBe(true);
  });
});

describe('AgentSession', () => {
  it('records turns, tracks tasks and persists', async () => {
    const store = new MemorySnapshotStore();
    const session = AgentSession.create(store, { sessionId: 's1', origin: 'desktop', provider });

    session.addTask({ id: 't1', title: 'ship it', status: 'pending' });
    session.recordTurn([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]);
    session.setTaskStatus('t1', 'running');
    await session.persist();

    const restored = await AgentSession.restore(store);
    expect(restored?.conversation).toHaveLength(2);
    expect(restored?.pendingTasks().map((t) => t.id)).toEqual(['t1']);
  });

  it('restore returns undefined for an empty store', async () => {
    expect(await AgentSession.restore(new MemorySnapshotStore())).toBeUndefined();
  });
});
