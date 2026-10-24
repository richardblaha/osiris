import type { EmbeddingsInterface } from "@langchain/core/embeddings";
import type { Client } from "@libsql/client";
import type { SearchFilters, VectorStore, VectorStoreResult } from "mem0ai/oss";
import { ftsQuery } from "../files/index.ts";
import { fromIdName, userDir, type Records } from "../projects/records.ts";

/** Mem0's scope (`agent_id`) of the project's own memories, and of the knowledge base's chunks. */
export const PROJECT_AGENT = "project";
export const KNOWLEDGE_AGENT = "knowledge";

type Payload = Record<string, unknown> & { data?: string };

export interface FileVectorStoreConfig {
  collectionName: string;
  records: Records;
  cache: Client;
  embeddings: EmbeddingsInterface;
  /** The stores Mem0 created, by collection, for direct reads. */
  registry?: Map<string, FileVectorStore>;
}

const toBlob = (v: number[]) => Buffer.from(new Float32Array(v).buffer);
const fromBlob = (b: unknown) => {
  const buf = b instanceof ArrayBuffer ? Buffer.from(b) : Buffer.from(b as Uint8Array);
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
};
function cosine(a: ArrayLike<number>, b: ArrayLike<number>) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** Equality per key (also `{ in: [...] }`), on the payload; Mem0 passes the scope keys and our own. */
function matches(payload: Payload, filters?: SearchFilters): boolean {
  for (const [k, v] of Object.entries(filters ?? {})) {
    if (v === undefined) continue;
    const actual = payload[k];
    const list = v && typeof v === "object" ? ((v as { in?: unknown[]; $in?: unknown[] }).in ?? (v as { $in?: unknown[] }).$in) : undefined;
    if (list ? !list.includes(actual) : actual !== v) return false;
  }
  return true;
}

/** Whether two payloads say the same, apart from key order and the derived `textLemmatized`. */
function same(a: Payload, b: Payload): boolean {
  const norm = (p: Payload) => JSON.stringify(Object.entries(p).filter(([k, v]) => k !== "textLemmatized" && v !== undefined).sort(([x], [y]) => x.localeCompare(y)));
  return norm(a) === norm(b);
}

/** A point as a Markdown file: the payload (without its text) as JSON frontmatter, then the text. */
const format = ({ data, textLemmatized: _, ...rest }: Payload) => `---\n${JSON.stringify(rest)}\n---\n\n${data ?? ""}\n`;
function parse(text: string): Payload | undefined {
  const m = /^---\n(.*)\n---\n\n?([\s\S]*)$/.exec(text);
  if (!m) return undefined;
  try {
    return { ...(JSON.parse(m[1]!) as Payload), data: m[2]!.replace(/\n$/, "") };
  } catch {
    return undefined;
  }
}

/**
 * Mem0's vector store over the project's files. A memory is a Markdown file (`memory/<id>.md`, a user's in their private
 * folder) and so is a graph entity (`memory/entities/<id>.md`); the files are the truth, versioned with the project.
 * Knowledge chunks are derived from the documents and live only in the cache. Vectors and the keyword index are in the
 * cache (`mem0_points`, `mem0_text`); `initialize` brings them in step with the files.
 */
// shortcut: search scans every vector of the collection (memories and knowledge pieces) in JS, fine to a few thousand; a libSQL vector index beyond.
export class FileVectorStore implements VectorStore {
  private readonly collection: string;
  private readonly entities: boolean;
  private readonly records: Records;
  private readonly cache: Client;
  private readonly embeddings: EmbeddingsInterface;

  constructor(config: FileVectorStoreConfig) {
    this.collection = config.collectionName;
    this.entities = this.collection.endsWith("_entities");
    this.records = config.records;
    this.cache = config.cache;
    this.embeddings = config.embeddings;
    config.registry?.set(this.collection, this);
  }

  /** The file of a point, or null for one kept only in the cache (knowledge chunks). */
  private fileOf(id: string, payload: Payload): string | null {
    if (payload.agent_id === KNOWLEDGE_AGENT) return null;
    const base = typeof payload.user_id === "string" && payload.user_id ? `${userDir(payload.user_id)}/memory` : "memory";
    return `${base}/${this.entities ? "entities/" : ""}${id}.md`;
  }

  /** The folders this collection's files are in. */
  private async folders(): Promise<string[]> {
    const users = (await this.records.list("private/users")).map((u) => userDir(fromIdName(u)));
    return ["", ...users].map((d) => `${d ? `${d}/` : ""}memory${this.entities ? "/entities" : ""}`);
  }

  private async upsert(id: string, payload: Payload, vector: number[] | Float32Array, file: string | null) {
    const blob = vector instanceof Float32Array ? Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength) : toBlob(vector);
    await this.cache.batch(
      [
        { sql: "DELETE FROM mem0_text WHERE rowid IN (SELECT rowid FROM mem0_points WHERE collection = ? AND id = ?)", args: [this.collection, id] },
        {
          sql: `INSERT INTO mem0_points (collection, id, file, payload, vector) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT (collection, id) DO UPDATE SET file = excluded.file, payload = excluded.payload, vector = excluded.vector`,
          args: [this.collection, id, file, JSON.stringify(payload), blob],
        },
        { sql: "INSERT INTO mem0_text (rowid, content) SELECT rowid, ? FROM mem0_points WHERE collection = ? AND id = ?", args: [String(payload.data ?? ""), this.collection, id] },
      ],
      "write",
    );
  }

  /** The collection's points; vectors (4 kB each) only when asked, as only search needs them. */
  private async rows(vectors = false): Promise<{ id: string; file: string | null; payload: Payload; vector: unknown }[]> {
    const { rows } = await this.cache.execute({ sql: `SELECT id, file, payload${vectors ? ", vector" : ""} FROM mem0_points WHERE collection = ?`, args: [this.collection] });
    return rows.map((r) => ({ id: String(r.id), file: r.file == null ? null : String(r.file), payload: JSON.parse(String(r.payload)) as Payload, vector: r.vector }));
  }

  async insert(vectors: number[][], ids: string[], payloads: Record<string, any>[]): Promise<void> {
    for (const [i, id] of ids.entries()) {
      const file = this.fileOf(id, payloads[i]!);
      if (file) await this.records.writeText(file, format(payloads[i]!));
      await this.upsert(id, payloads[i]!, vectors[i]!, file);
    }
  }

  async search(query: number[], topK = 10, filters?: SearchFilters): Promise<VectorStoreResult[]> {
    return (await this.rows(true))
      .filter((r) => matches(r.payload, filters))
      .map((r) => ({ id: r.id, payload: r.payload, score: cosine(query, fromBlob(r.vector)) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  /** Word matches (FTS5, without diacritics) with BM25 as a positive score, as Mem0 expects. */
  async keywordSearch(query: string, topK = 10, filters?: SearchFilters): Promise<VectorStoreResult[] | null> {
    const match = ftsQuery(query, "OR");
    if (!match) return [];
    const { rows } = await this.cache.execute({
      sql: `SELECT p.id, p.payload, -bm25(mem0_text) AS score FROM mem0_text t JOIN mem0_points p ON p.rowid = t.rowid
            WHERE mem0_text MATCH ? AND p.collection = ? ORDER BY bm25(mem0_text) LIMIT ?`,
      args: [match, this.collection, topK * 4],
    });
    return rows
      .map((r) => ({ id: String(r.id), payload: JSON.parse(String(r.payload)) as Payload, score: Number(r.score) }))
      .filter((r) => matches(r.payload, filters))
      .slice(0, topK);
  }

  async get(vectorId: string): Promise<VectorStoreResult | null> {
    const { rows } = await this.cache.execute({ sql: "SELECT payload FROM mem0_points WHERE collection = ? AND id = ?", args: [this.collection, vectorId] });
    return rows[0] ? { id: vectorId, payload: JSON.parse(String(rows[0].payload)) as Payload } : null;
  }

  async update(vectorId: string, vector: number[], payload: Record<string, any>): Promise<void> {
    const { rows } = await this.cache.execute({ sql: "SELECT file FROM mem0_points WHERE collection = ? AND id = ?", args: [this.collection, vectorId] });
    const file = this.fileOf(vectorId, payload);
    const old = rows[0]?.file == null ? null : String(rows[0].file);
    if (old && old !== file) await this.records.remove(old);
    if (file) await this.records.writeText(file, format(payload));
    await this.upsert(vectorId, payload, vector, file);
  }

  async delete(vectorId: string): Promise<void> {
    const { rows } = await this.cache.execute({ sql: "SELECT file FROM mem0_points WHERE collection = ? AND id = ?", args: [this.collection, vectorId] });
    if (rows[0]?.file != null) await this.records.remove(String(rows[0].file));
    await this.cache.batch(
      [
        { sql: "DELETE FROM mem0_text WHERE rowid IN (SELECT rowid FROM mem0_points WHERE collection = ? AND id = ?)", args: [this.collection, vectorId] },
        { sql: "DELETE FROM mem0_points WHERE collection = ? AND id = ?", args: [this.collection, vectorId] },
      ],
      "write",
    );
  }

  /** Mem0's reset: forgets the cache of the collection; the files stay (they are the project's). */
  async deleteCol(): Promise<void> {
    await this.cache.batch(
      [
        { sql: "DELETE FROM mem0_text WHERE rowid IN (SELECT rowid FROM mem0_points WHERE collection = ?)", args: [this.collection] },
        { sql: "DELETE FROM mem0_points WHERE collection = ?", args: [this.collection] },
      ],
      "write",
    );
  }

  async list(filters?: SearchFilters, topK = 100): Promise<[VectorStoreResult[], number]> {
    const all = (await this.rows()).filter((r) => matches(r.payload, filters)).map((r) => ({ id: r.id, payload: r.payload }));
    return [all.slice(0, topK), all.length];
  }

  async getUserId(): Promise<string> {
    return "osiris";
  }

  async setUserId(): Promise<void> {}

  /**
   * Brings the cache in step with the files: points whose file is new or changed (a restore, a git pull, a lost cache)
   * are embedded again, and points whose file is gone are dropped.
   */
  async initialize(): Promise<void> {
    const known = new Map((await this.rows()).filter((r) => r.file).map((r) => [r.file!, r]));
    const stale: { id: string; file: string; payload: Payload }[] = [];
    for (const dir of await this.folders()) {
      for (const name of await this.records.list(dir)) {
        if (!name.endsWith(".md")) continue;
        const file = `${dir}/${name}`;
        const text = await this.records.readText(file).catch(() => undefined);
        const payload = text === undefined ? undefined : parse(text);
        if (!payload) continue;
        const row = known.get(file);
        known.delete(file);
        if (row && same(row.payload, payload)) continue;
        stale.push({ id: name.slice(0, -3), file, payload });
      }
    }
    for (const gone of known.values()) await this.delete(gone.id);
    if (!stale.length) return;
    const vectors = await this.embeddings.embedDocuments(stale.map((s) => String(s.payload.data ?? "")));
    for (const [i, s] of stale.entries()) await this.upsert(s.id, s.payload, vectors[i]!, s.file);
  }
}
