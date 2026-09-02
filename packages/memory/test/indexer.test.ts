import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reindex, type IndexSource } from '../src/indexer.js';
import { hashEmbedding } from '../src/embed.js';
import { InMemoryMemoryStore, DEFAULT_HNSW } from '../src/store.js';
import { searchMemory } from '../src/search.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'memory-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const sources = (): IndexSource[] => [
  { relPath: 'a.md', content: '# Alpha\n\nThe orphan branch keeps backlog churn off main.' },
  { relPath: 'b.md', content: '# Beta\n\nChromaDB stores the knowledge base with HNSW indexing.' },
];

describe('reindex', () => {
  it('indexes, then does nothing on an unchanged re-run', async () => {
    const store = new InMemoryMemoryStore();
    const embed = vi.fn(hashEmbedding(128));
    const opts = { store, embed, cachePath: join(dir, 'idx.json'), hnsw: DEFAULT_HNSW };

    const first = await reindex(sources(), opts);
    expect(first.filesIndexed).toBe(2);
    expect(first.chunksUpserted).toBeGreaterThan(0);
    const callsAfterFirst = embed.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    const second = await reindex(sources(), opts);
    expect(second.filesIndexed).toBe(0);
    expect(second.filesUnchanged).toBe(2);
    expect(second.chunksUpserted).toBe(0);
    expect(embed.mock.calls.length).toBe(callsAfterFirst); // zero further embedding calls
  });

  it('re-embeds only the file that changed', async () => {
    const store = new InMemoryMemoryStore();
    const embed = vi.fn(hashEmbedding(128));
    const opts = { store, embed, cachePath: join(dir, 'idx.json'), hnsw: DEFAULT_HNSW };
    await reindex(sources(), opts);
    embed.mockClear();

    const changed = sources();
    changed[0]!.content = '# Alpha\n\nA completely different sentence about pyramids.';
    const report = await reindex(changed, opts);

    expect(report.filesIndexed).toBe(1);
    expect(report.filesUnchanged).toBe(1);
    expect(embed).toHaveBeenCalledTimes(1);
  });

  it('deletes chunks for a removed file', async () => {
    const store = new InMemoryMemoryStore();
    const embed = hashEmbedding(128);
    const opts = { store, embed, cachePath: join(dir, 'idx.json'), hnsw: DEFAULT_HNSW };
    await reindex(sources(), opts);
    const before = await store.count();

    const report = await reindex([sources()[0]!], opts);
    expect(report.filesRemoved).toBe(1);
    expect(await store.count()).toBeLessThan(before);
  });

  it('dedupes an identical passage shared by two files', async () => {
    const store = new InMemoryMemoryStore();
    const embed = vi.fn(hashEmbedding(128));
    const shared = '# Shared\n\nThe exact same paragraph in both files.';
    const report = await reindex(
      [
        { relPath: 'x.md', content: shared },
        { relPath: 'y.md', content: shared },
      ],
      { store, embed, cachePath: join(dir, 'idx.json'), hnsw: DEFAULT_HNSW },
    );
    expect(report.chunksDeduped).toBeGreaterThan(0);
    expect(report.chunksUpserted).toBe(2); // both records written, one embedding computed
  });

  it('finds an indexed chunk via searchMemory', async () => {
    const store = new InMemoryMemoryStore();
    const embed = hashEmbedding(128);
    await reindex(sources(), {
      store,
      embed,
      cachePath: join(dir, 'idx.json'),
      hnsw: DEFAULT_HNSW,
    });
    const hits = await searchMemory('chromadb hnsw knowledge base', { store, embed, k: 1 });
    expect(hits[0]!.metadata.source).toBe('b.md');
  });
});
