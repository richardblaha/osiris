import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hashEmbedding } from '../src/embed.js';
import { DEFAULT_HNSW } from '../src/store.js';
import { buildMemoryStore, parseMemoryConfig } from '../src/config.js';
import { reindex } from '../src/indexer.js';
import { searchMemory } from '../src/search.js';

// Runs only when a real ChromaDB is available (CI service container or
// `OSIRIS_TEST_CHROMA_URL=http://localhost:8000 pnpm --filter @richardblaha/osiris-memory test`).
const CHROMA_URL = process.env.OSIRIS_TEST_CHROMA_URL;
const run = CHROMA_URL ? describe : describe.skip;

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'chroma-it-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

run('ChromaMemoryStore against a real server', () => {
  const embed = hashEmbedding(128);

  it('builds a Chroma store, indexes, and HNSW-searches it', async () => {
    const config = parseMemoryConfig(
      JSON.stringify({
        chroma: { url: CHROMA_URL, collection: `it-${Date.now()}` },
        embedding: { provider: 'hash', dimensions: 128 },
      }),
      {},
    );
    const store = await buildMemoryStore(config, { env: {} });
    expect(store.constructor.name).toBe('ChromaMemoryStore');

    const cachePath = join(dir, 'idx.json');
    const first = await reindex(
      [
        { relPath: 'a.md', content: '# Alpha\n\nThe orphan branch keeps backlog churn off main.' },
        {
          relPath: 'b.md',
          content: '# Beta\n\nChromaDB stores the knowledge base with HNSW indexing.',
        },
      ],
      { store, embed, cachePath, hnsw: { ...DEFAULT_HNSW, space: 'cosine' } },
    );
    expect(first.chunksUpserted).toBe(2);
    expect(await store.count()).toBe(2);

    const hits = await searchMemory('chromadb hnsw knowledge base', { store, embed, k: 1 });
    expect(hits[0]!.metadata.source).toBe('b.md');

    // Re-index with a changed file: only that file's chunk is touched.
    const second = await reindex(
      [
        { relPath: 'a.md', content: '# Alpha\n\nThe orphan branch keeps backlog churn off main.' },
        { relPath: 'b.md', content: '# Beta\n\nA completely different sentence about pyramids.' },
      ],
      { store, embed, cachePath, hnsw: DEFAULT_HNSW },
    );
    expect(second.filesIndexed).toBe(1);
    expect(second.filesUnchanged).toBe(1);
  });
});
