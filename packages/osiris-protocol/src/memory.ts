/** Knowledge-base search + reindex over the `.osiris/memory/` corpus. */
import { z } from 'zod';

export const MemorySearchRequest = z.object({
  query: z.string().min(1),
  k: z.number().int().positive().max(50).default(6),
  source: z.string().optional(),
});
export type MemorySearchRequest = z.infer<typeof MemorySearchRequest>;

export const MemoryHit = z.object({
  id: z.string(),
  document: z.string(),
  source: z.string(),
  headingPath: z.string(),
  score: z.number(),
});
export type MemoryHit = z.infer<typeof MemoryHit>;

export const MemorySearchResult = z.object({
  hits: z.array(MemoryHit),
});
export type MemorySearchResult = z.infer<typeof MemorySearchResult>;

export const MemoryReindexResult = z.object({
  filesIndexed: z.number(),
  filesUnchanged: z.number(),
  filesRemoved: z.number(),
  chunksUpserted: z.number(),
  chunksDeleted: z.number(),
  chunksDeduped: z.number(),
  embeddingCalls: z.number(),
});
export type MemoryReindexResult = z.infer<typeof MemoryReindexResult>;
