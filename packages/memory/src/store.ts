import { createLogger } from '@osiris/shared-core';

const log = createLogger('memory:store');

export interface HnswConfig {
  space: 'cosine' | 'l2' | 'ip';
  M: number;
  efConstruction: number;
  efSearch: number;
}

export const DEFAULT_HNSW: HnswConfig = {
  space: 'cosine',
  M: 16,
  efConstruction: 200,
  efSearch: 64,
};

export type MetadataValue = string | number | boolean;

export interface MemoryRecord {
  id: string;
  document: string;
  embedding: number[];
  metadata: Record<string, MetadataValue>;
}

export interface QueryHit {
  id: string;
  document: string;
  metadata: Record<string, MetadataValue>;
  /** Distance in the collection's space (lower = closer). */
  distance: number;
}

export interface MemoryStore {
  ensureCollection(hnsw: HnswConfig): Promise<void>;
  upsert(records: MemoryRecord[]): Promise<void>;
  deleteByIds(ids: string[]): Promise<void>;
  query(embedding: number[], k: number, where?: Record<string, MetadataValue>): Promise<QueryHit[]>;
  count(): Promise<number>;
}

function cosineDistance(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb) || 1;
  return 1 - dot / denom;
}

/** In-process store with exact cosine search. The tested default; also handy for CI. */
export class InMemoryMemoryStore implements MemoryStore {
  protected readonly records = new Map<string, MemoryRecord>();
  hnsw: HnswConfig = DEFAULT_HNSW;

  /** Every stored record (unordered). */
  all(): MemoryRecord[] {
    return [...this.records.values()];
  }

  async ensureCollection(hnsw: HnswConfig): Promise<void> {
    this.hnsw = hnsw;
  }

  async upsert(records: MemoryRecord[]): Promise<void> {
    for (const r of records) this.records.set(r.id, r);
  }

  async deleteByIds(ids: string[]): Promise<void> {
    for (const id of ids) this.records.delete(id);
  }

  async query(
    embedding: number[],
    k: number,
    where?: Record<string, MetadataValue>,
  ): Promise<QueryHit[]> {
    const matches = [...this.records.values()].filter((r) =>
      where ? Object.entries(where).every(([key, val]) => r.metadata[key] === val) : true,
    );
    return matches
      .map((r) => ({
        id: r.id,
        document: r.document,
        metadata: r.metadata,
        distance: cosineDistance(embedding, r.embedding),
      }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, k);
  }

  async count(): Promise<number> {
    return this.records.size;
  }
}

/**
 * `InMemoryMemoryStore` that persists its records to a JSON file, so a CLI
 * invocation can search what a previous `reindex` wrote without a running
 * ChromaDB. Load with `FileMemoryStore.open(path)`.
 */
export class FileMemoryStore extends InMemoryMemoryStore {
  private loading = false;

  private constructor(private readonly path: string) {
    super();
  }

  static async open(path: string): Promise<FileMemoryStore> {
    const store = new FileMemoryStore(path);
    store.loading = true;
    try {
      const { readFile } = await import('node:fs/promises');
      const rows = JSON.parse(await readFile(path, 'utf8')) as MemoryRecord[];
      await store.upsert(rows);
    } catch {
      /* first run */
    }
    store.loading = false;
    return store;
  }

  private async flush(): Promise<void> {
    if (this.loading) return;
    const { mkdir, writeFile } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(this.all()), 'utf8');
  }

  override async upsert(records: MemoryRecord[]): Promise<void> {
    await super.upsert(records);
    if (records.length) await this.flush();
  }

  override async deleteByIds(ids: string[]): Promise<void> {
    await super.deleteByIds(ids);
    await this.flush();
  }
}

export interface ChromaStoreOptions {
  url: string;
  collection: string;
}

/**
 * ChromaDB-backed store. `chromadb` is imported lazily so packages that only use
 * the in-memory store never pull it in. HNSW parameters are passed on collection
 * creation via the `hnsw:*` metadata keys Chroma understands.
 */
export class ChromaMemoryStore implements MemoryStore {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private collection: any;

  constructor(private readonly options: ChromaStoreOptions) {}

  async ensureCollection(hnsw: HnswConfig): Promise<void> {
    const mod = (await import('chromadb')) as unknown as {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ChromaClient: new (opts: { path: string }) => any;
    };
    const client = new mod.ChromaClient({ path: this.options.url });
    this.collection = await client.getOrCreateCollection({
      name: this.options.collection,
      metadata: {
        'hnsw:space': hnsw.space,
        'hnsw:M': hnsw.M,
        'hnsw:construction_ef': hnsw.efConstruction,
        'hnsw:search_ef': hnsw.efSearch,
      },
      // We always supply embeddings explicitly.
      embeddingFunction: { generate: async (texts: string[]) => texts.map(() => [] as number[]) },
    });
    log.info('chroma collection %s ready at %s', this.options.collection, this.options.url);
  }

  private assertReady(): void {
    if (!this.collection) throw new Error('ChromaMemoryStore: call ensureCollection() first');
  }

  async upsert(records: MemoryRecord[]): Promise<void> {
    this.assertReady();
    if (records.length === 0) return;
    await this.collection.upsert({
      ids: records.map((r) => r.id),
      embeddings: records.map((r) => r.embedding),
      documents: records.map((r) => r.document),
      metadatas: records.map((r) => r.metadata),
    });
  }

  async deleteByIds(ids: string[]): Promise<void> {
    this.assertReady();
    if (ids.length === 0) return;
    await this.collection.delete({ ids });
  }

  async query(
    embedding: number[],
    k: number,
    where?: Record<string, MetadataValue>,
  ): Promise<QueryHit[]> {
    this.assertReady();
    const res = await this.collection.query({
      queryEmbeddings: [embedding],
      nResults: k,
      where,
    });
    const ids: string[] = res.ids?.[0] ?? [];
    const docs: string[] = res.documents?.[0] ?? [];
    const metas: Record<string, MetadataValue>[] = res.metadatas?.[0] ?? [];
    const dists: number[] = res.distances?.[0] ?? [];
    return ids.map((id, i) => ({
      id,
      document: docs[i] ?? '',
      metadata: metas[i] ?? {},
      distance: dists[i] ?? 0,
    }));
  }

  async count(): Promise<number> {
    this.assertReady();
    return this.collection.count();
  }
}
