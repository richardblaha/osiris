import { DEFAULT_HNSW, type HnswConfig, type MemoryStore } from './store.js';
import { ChromaMemoryStore, FileMemoryStore, InMemoryMemoryStore } from './store.js';
import { createEmbedding, type EmbeddingConfig, type EmbeddingFn } from './embed.js';

export interface MemoryConfig {
  chroma: { url: string; collection: string };
  index: { chunkSize: number; chunkOverlap: number; hnsw: HnswConfig };
  embedding: EmbeddingConfig;
}

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  chroma: { url: '', collection: 'osiris-memory' },
  index: { chunkSize: 1200, chunkOverlap: 200, hnsw: DEFAULT_HNSW },
  embedding: { provider: 'hash', dimensions: 512 },
};

/** Expand `${VAR}` / `${VAR:-default}` against `env`. */
export function expandEnv(input: string, env: NodeJS.ProcessEnv): string {
  return input.replace(/\$\{([A-Z0-9_]+)(?::-([^}]*))?\}/gi, (_m, name: string, fallback = '') =>
    env[name] && env[name] !== '' ? (env[name] as string) : fallback,
  );
}

/** Merge `.osiris/memory.json` (raw text) over the defaults, expanding `${ENV}`. */
export function parseMemoryConfig(
  raw: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): MemoryConfig {
  const base = structuredClone(DEFAULT_MEMORY_CONFIG);
  if (!raw) return base;
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(expandEnv(raw, env)) as Record<string, unknown>;
  } catch {
    return base;
  }
  const chroma = (json.chroma ?? {}) as Partial<MemoryConfig['chroma']>;
  const index = (json.index ?? {}) as Record<string, unknown>;
  const embedding = (json.embedding ?? {}) as Partial<EmbeddingConfig>;
  return {
    chroma: {
      url: chroma.url ?? env.OSIRIS_CHROMA_URL ?? base.chroma.url,
      collection: chroma.collection ?? base.chroma.collection,
    },
    index: {
      chunkSize: (index.chunkSize as number) ?? base.index.chunkSize,
      chunkOverlap: (index.chunkOverlap as number) ?? base.index.chunkOverlap,
      hnsw: { ...base.index.hnsw, ...(index.hnsw as Partial<HnswConfig>) },
    },
    embedding: {
      provider: embedding.provider ?? base.embedding.provider,
      model: embedding.model,
      endpoint: embedding.endpoint,
      apiKey: embedding.apiKey,
      dimensions: embedding.dimensions ?? base.embedding.dimensions,
    },
  };
}

export interface BuildStoreOptions {
  /** Persist an in-process store here when ChromaDB is not configured. */
  filePath?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Pick a `MemoryStore` for `config`: ChromaDB when a URL is set, otherwise a
 * file-backed store (if `filePath` given) or a pure in-memory one.
 */
export async function buildMemoryStore(
  config: MemoryConfig,
  options: BuildStoreOptions = {},
): Promise<MemoryStore> {
  const url = options.env?.OSIRIS_CHROMA_URL ?? config.chroma.url;
  if (url && /^https?:\/\//.test(url)) {
    return new ChromaMemoryStore({ url, collection: config.chroma.collection });
  }
  if (options.filePath) return FileMemoryStore.open(options.filePath);
  return new InMemoryMemoryStore();
}

export function buildEmbedding(config: MemoryConfig): EmbeddingFn {
  return createEmbedding(config.embedding);
}
