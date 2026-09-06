import type { EmbeddingFn } from './embed.js';
import type { MemoryStore, MetadataValue, QueryHit } from './store.js';

export interface SearchOptions {
  store: MemoryStore;
  embed: EmbeddingFn;
  /** Max hits. Default 6. */
  k?: number;
  /** Metadata equality filter, e.g. `{ source: 'decisions/no-dotnet.md' }`. */
  where?: Record<string, MetadataValue>;
}

export interface SearchResult extends QueryHit {
  /** `1 - distance` for a cosine collection; a rough 0..1 relevance. */
  score: number;
}

/** Embed `query` and return the nearest chunks. */
export async function searchMemory(query: string, options: SearchOptions): Promise<SearchResult[]> {
  const [embedding] = await options.embed([query]);
  const hits = await options.store.query(embedding!, options.k ?? 6, options.where);
  return hits.map((h) => ({ ...h, score: Math.max(0, 1 - h.distance) }));
}
