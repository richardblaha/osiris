import { createHash } from 'node:crypto';

/** Turn a batch of texts into a batch of embedding vectors (row-aligned). */
export type EmbeddingFn = (texts: string[]) => Promise<number[][]>;

function l2normalize(vec: number[]): number[] {
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  return vec.map((v) => v / norm);
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9À-ɏ]+/g, ' ')
    .split(' ')
    .filter(Boolean);
}

/**
 * Deterministic, offline embedding: hashed bag of uni/bi-grams projected into a
 * fixed-dimension vector, L2-normalised. Not competitive with a real model but
 * stable, dependency-free and good enough for local dedupe + coarse retrieval
 * and for tests.
 */
export function hashEmbedding(dimensions = 512): EmbeddingFn {
  const bucket = (token: string): number => {
    const h = createHash('md5').update(token).digest();
    return ((h[0]! << 8) | h[1]!) % dimensions;
  };
  return async (texts) =>
    texts.map((text) => {
      const vec = new Array<number>(dimensions).fill(0);
      const toks = tokenize(text);
      const bump = (i: number): void => {
        vec[i] = (vec[i] ?? 0) + 1;
      };
      for (let i = 0; i < toks.length; i++) {
        const tok = toks[i]!;
        bump(bucket(tok));
        const next = toks[i + 1];
        if (next) bump(bucket(`${tok}_${next}`));
      }
      return l2normalize(vec);
    });
}

export interface HttpEmbeddingOptions {
  endpoint: string;
  model: string;
  apiKey?: string;
  /** Fallback used when the endpoint is unreachable or unset (tests / air-gapped). */
  fallbackDimensions?: number;
}

/** OpenAI-compatible `/v1/embeddings`. Falls back to `hashEmbedding` on failure. */
export function openAiCompatibleEmbedding(options: HttpEmbeddingOptions): EmbeddingFn {
  const fallback = hashEmbedding(options.fallbackDimensions ?? 512);
  return async (texts) => {
    if (!options.endpoint) return fallback(texts);
    try {
      const res = await fetch(`${options.endpoint.replace(/\/$/, '')}/embeddings`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
        },
        body: JSON.stringify({ model: options.model, input: texts }),
      });
      if (!res.ok) throw new Error(`embeddings ${res.status}`);
      const json = (await res.json()) as { data: { embedding: number[] }[] };
      return json.data.map((d) => d.embedding);
    } catch {
      return fallback(texts);
    }
  };
}

/** Ollama native `/api/embed`. Falls back to `hashEmbedding` on failure. */
export function ollamaEmbedding(options: HttpEmbeddingOptions): EmbeddingFn {
  const fallback = hashEmbedding(options.fallbackDimensions ?? 512);
  return async (texts) => {
    if (!options.endpoint) return fallback(texts);
    try {
      const res = await fetch(`${options.endpoint.replace(/\/$/, '')}/api/embed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: options.model, input: texts }),
      });
      if (!res.ok) throw new Error(`embed ${res.status}`);
      const json = (await res.json()) as { embeddings: number[][] };
      return json.embeddings;
    } catch {
      return fallback(texts);
    }
  };
}

export interface EmbeddingConfig {
  provider: 'hash' | 'openai-compatible' | 'ollama';
  model?: string;
  endpoint?: string;
  apiKey?: string;
  dimensions?: number;
}

/** Build an `EmbeddingFn` from the `embedding` block of `.osiris/memory.json`. */
export function createEmbedding(config: EmbeddingConfig): EmbeddingFn {
  switch (config.provider) {
    case 'openai-compatible':
      return openAiCompatibleEmbedding({
        endpoint: config.endpoint ?? '',
        model: config.model ?? 'text-embedding-3-small',
        apiKey: config.apiKey,
        fallbackDimensions: config.dimensions,
      });
    case 'ollama':
      return ollamaEmbedding({
        endpoint: config.endpoint ?? '',
        model: config.model ?? 'nomic-embed-text',
        fallbackDimensions: config.dimensions,
      });
    default:
      return hashEmbedding(config.dimensions ?? 512);
  }
}
