import { createLogger } from '@richardblaha/osiris-core';
import { chunkMarkdown } from './chunk.js';
import { contentDigest, fileDigest } from './hash.js';
import { IndexCache } from './cache.js';
import type { EmbeddingFn } from './embed.js';
import type { HnswConfig, MemoryRecord, MemoryStore } from './store.js';

const log = createLogger('memory:indexer');

export interface IndexSource {
  /** Path relative to `.osiris/memory/`, e.g. `decisions/no-dotnet.md`. */
  relPath: string;
  content: string;
}

export interface ReindexOptions {
  store: MemoryStore;
  embed: EmbeddingFn;
  /** Absolute path of the index cache JSON (under `.osiris/temp/`). */
  cachePath: string;
  hnsw: HnswConfig;
  chunkSize?: number;
  chunkOverlap?: number;
}

export interface ReindexReport {
  filesIndexed: number;
  filesUnchanged: number;
  filesRemoved: number;
  chunksUpserted: number;
  chunksDeleted: number;
  /** Chunks skipped because their text was already embedded (this run or ever). */
  chunksDeduped: number;
  /** Number of texts actually sent to the embedding function. */
  embeddingCalls: number;
}

function chunkId(relPath: string, index: number): string {
  return `${relPath}#${index}`;
}

/**
 * Incrementally bring the vector store in line with `sources`.
 *
 * - Unchanged files (same `fileDigest`) are skipped entirely — no chunking, no
 *   embedding, no upsert.
 * - For changed/new files, only chunks whose text has never been embedded are
 *   sent to `embed`; the rest reuse the cached vector.
 * - Files that vanished from `sources` have their chunks deleted.
 */
export async function reindex(
  sources: IndexSource[],
  options: ReindexOptions,
): Promise<ReindexReport> {
  const cache = await IndexCache.load(options.cachePath);
  await options.store.ensureCollection(options.hnsw);

  const report: ReindexReport = {
    filesIndexed: 0,
    filesUnchanged: 0,
    filesRemoved: 0,
    chunksUpserted: 0,
    chunksDeleted: 0,
    chunksDeduped: 0,
    embeddingCalls: 0,
  };

  const seenPaths = new Set<string>();

  for (const source of sources) {
    seenPaths.add(source.relPath);
    const digest = fileDigest(source.relPath, source.content);
    const prior = cache.get(source.relPath);
    if (prior && prior.fileDigest === digest) {
      report.filesUnchanged++;
      continue;
    }

    const chunks = chunkMarkdown(source.content, {
      chunkSize: options.chunkSize,
      chunkOverlap: options.chunkOverlap,
    });

    // Retire the file's previous chunks before writing the new set.
    if (prior?.chunkIds.length) {
      await options.store.deleteByIds(prior.chunkIds);
      report.chunksDeleted += prior.chunkIds.length;
    }

    const contentDigests = chunks.map((c) => contentDigest(c.text));
    const toEmbed: { at: number; text: string }[] = [];
    chunks.forEach((c, i) => {
      if (!cache.cachedEmbedding(contentDigests[i]!)) toEmbed.push({ at: i, text: c.text });
      else report.chunksDeduped++;
    });

    if (toEmbed.length) {
      const vectors = await options.embed(toEmbed.map((t) => t.text));
      report.embeddingCalls += toEmbed.length;
      toEmbed.forEach((t, i) => cache.putEmbedding(contentDigests[t.at]!, vectors[i]!));
    }

    const records: MemoryRecord[] = chunks.map((c, i) => ({
      id: chunkId(source.relPath, i),
      document: c.text,
      embedding: cache.cachedEmbedding(contentDigests[i]!)!,
      metadata: {
        source: source.relPath,
        chunkIndex: i,
        headingPath: c.headingPath.join(' > '),
        startLine: c.startLine,
        contentDigest: contentDigests[i]!,
      },
    }));

    await options.store.upsert(records);
    report.chunksUpserted += records.length;
    cache.set(source.relPath, {
      fileDigest: digest,
      chunkIds: records.map((r) => r.id),
      contentDigests,
    });
    report.filesIndexed++;
  }

  for (const relPath of cache.trackedFiles()) {
    if (seenPaths.has(relPath)) continue;
    const stale = cache.get(relPath);
    if (stale?.chunkIds.length) {
      await options.store.deleteByIds(stale.chunkIds);
      report.chunksDeleted += stale.chunkIds.length;
    }
    cache.delete(relPath);
    report.filesRemoved++;
  }

  cache.pruneEmbeddings();
  await cache.save();

  log.info(
    'reindex: %d new/changed, %d unchanged, %d removed, %d embed calls',
    report.filesIndexed,
    report.filesUnchanged,
    report.filesRemoved,
    report.embeddingCalls,
  );
  return report;
}
