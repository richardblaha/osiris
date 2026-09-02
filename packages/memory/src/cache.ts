import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface FileIndexRecord {
  /** `fileDigest()` of the source at last index. */
  fileDigest: string;
  /** Chroma record ids produced for this file. */
  chunkIds: string[];
  /** `contentDigest()` of each chunk, index-aligned with `chunkIds`. */
  contentDigests: string[];
}

export interface IndexCacheData {
  version: 1;
  files: Record<string, FileIndexRecord>;
  /** contentDigest → embedding vector, so identical passages are embedded once, ever. */
  embeddings: Record<string, number[]>;
}

const EMPTY: IndexCacheData = { version: 1, files: {}, embeddings: {} };

/**
 * The on-disk index cache (`.osiris/temp/memory-index.json`). Makes re-indexing
 * near-free: unchanged files are skipped by digest, and any passage that has
 * ever been embedded is never embedded again.
 */
export class IndexCache {
  private constructor(
    private readonly path: string,
    private data: IndexCacheData,
  ) {}

  static async load(path: string): Promise<IndexCache> {
    try {
      const raw = JSON.parse(await readFile(path, 'utf8')) as IndexCacheData;
      if (raw.version === 1 && raw.files && raw.embeddings) return new IndexCache(path, raw);
    } catch {
      /* missing or corrupt — start fresh */
    }
    return new IndexCache(path, structuredClone(EMPTY));
  }

  get(relPath: string): FileIndexRecord | undefined {
    return this.data.files[relPath];
  }

  set(relPath: string, record: FileIndexRecord): void {
    this.data.files[relPath] = record;
  }

  delete(relPath: string): void {
    delete this.data.files[relPath];
  }

  /** Every relative path currently tracked. */
  trackedFiles(): string[] {
    return Object.keys(this.data.files);
  }

  cachedEmbedding(contentDigest: string): number[] | undefined {
    return this.data.embeddings[contentDigest];
  }

  putEmbedding(contentDigest: string, vector: number[]): void {
    this.data.embeddings[contentDigest] = vector;
  }

  /** Drop embeddings no file references any more. Call before `save()`. */
  pruneEmbeddings(): number {
    const live = new Set<string>();
    for (const rec of Object.values(this.data.files)) {
      for (const d of rec.contentDigests) live.add(d);
    }
    let removed = 0;
    for (const digest of Object.keys(this.data.embeddings)) {
      if (!live.has(digest)) {
        delete this.data.embeddings[digest];
        removed++;
      }
    }
    return removed;
  }

  async save(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8');
  }
}
