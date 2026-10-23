import type { EmbeddingsInterface } from "@langchain/core/embeddings";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { createHash, randomUUID } from "node:crypto";
import type { DocumentSummary } from "@osiris/shared";
import { KNOWLEDGE_AGENT } from "../memory/file-vector-store.ts";
import type { MemoryEngine } from "../memory/mem0.ts";
import { formatFrontmatter, parseFrontmatter, userDir, userIds, type Records } from "../projects/records.ts";

/** Chunks of a document are keyed by path `knowledge/<id>`; it was the knowledge base's folder in the files. */
export const KNOWLEDGE_DIR = "knowledge";

/** A document's id: segments of letters, digits, dots, dashes and underscores, `/` between them (a folder). */
export const DOCUMENT_ID = /^[\p{L}\p{N}_-][\p{L}\p{N}._-]*(\/[\p{L}\p{N}_-][\p{L}\p{N}._-]*)*$/u;

export interface KnowledgeDocument {
  id: string;
  /** '' for the project's, a user's sub for their own. */
  owner: string;
  title: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

export interface SearchResult {
  owner: string;
  /** The file, e.g. knowledge/cenik.md. */
  path: string;
  title: string;
  content: string;
}

const splitter = new RecursiveCharacterTextSplitter({ chunkSize: 1000, chunkOverlap: 150 });

/** A document's title: its leading Markdown heading, or the file's name. */
export const titleOf = (path: string, text = "") => /^#\s+(.+)/.exec(text.trimStart())?.[1]?.trim() || (path.split("/").at(-1) ?? path).replace(/\.[^.]+$/, "");

/** Where an owner's documents are: the project's in `knowledge/`, a user's in their private folder. */
const docDir = (owner: string) => (owner ? `${userDir(owner)}/knowledge` : KNOWLEDGE_DIR);

/**
 * The knowledge base: the project's documents (Markdown files under `knowledge/`, a `title` in frontmatter when it
 * isn't the leading heading). Their chunks are points of Mem0's collection (scope `knowledge`, kept only in the cache),
 * indexed as a document is saved, and searched with Mem0 (meaning and words).
 *
 * Chunks record `embeddingModel`, so changing EMBEDDING_MODEL hides old vectors until `reindexStale` (at startup).
 */
export class KnowledgeStore {
  constructor(
    private readonly records: Records,
    private readonly engine: MemoryEngine,
    private readonly embeddings: EmbeddingsInterface,
    private readonly embeddingModel: string,
  ) {}

  /** The chunks of one owner's documents (`path` = knowledge/<id>), of the current embedding model unless `any`. */
  private async chunks(owner: string, any = false) {
    const [found] = await (await this.engine.points()).list({ agent_id: KNOWLEDGE_AGENT, owner, ...(any ? {} : { embedding_model: this.embeddingModel }) }, 1_000_000);
    return found.map((p) => ({ id: p.id, path: String(p.payload.path), idx: Number(p.payload.idx), content: String(p.payload.data ?? "") }));
  }

  /** (Re)indexes one file of the knowledge base. */
  async indexFile(owner: string, path: string, content: string): Promise<void> {
    await this.removeFile(owner, path, false);
    const pieces = (await splitter.splitText(content)).filter((p) => p.trim());
    if (!pieces.length) return;
    const vectors = await this.embeddings.embedDocuments(pieces);
    const createdAt = new Date().toISOString();
    await (await this.engine.points()).insert(
      vectors,
      pieces.map(() => randomUUID()),
      pieces.map((data, idx) => ({ data, hash: createHash("md5").update(data).digest("hex"), createdAt, agent_id: KNOWLEDGE_AGENT, owner, path, idx, embedding_model: this.embeddingModel })),
    );
  }

  /** Drops a file's chunks, or those of every file under a folder. */
  async removeFile(owner: string, path: string, folder = true): Promise<void> {
    const points = await this.engine.points();
    for (const c of await this.chunks(owner, true)) if (c.path === path || (folder && c.path.startsWith(`${path}/`))) await points.delete(c.id);
  }

  /**
   * Searches the project's documents plus `userId`'s own. A project document the user has their own copy of (same id)
   * is left out: theirs replaces it for them.
   */
  async search(query: string, userId = "", limit = 5, { under }: { under?: string[] } = {}): Promise<SearchResult[]> {
    // `under`: only the project's files that are these files or in these folders (a public assistant's knowledge).
    if (under && !under.length) return [];
    const own = new Set(userId && !under ? (await this.ids(userId)).map((id) => `${KNOWLEDGE_DIR}/${id}`) : []);
    // Only the scope goes to Mem0 (it rewrites other filter keys); the embedding model is checked on the results.
    // No threshold: a word match counts even far in meaning, and the nearest of what the user may see is returned.
    const { results } = await this.engine.memory.search(query, { filters: { agent_id: KNOWLEDGE_AGENT }, topK: Math.max(limit * 4, 20), threshold: 0 });
    const fits = (owner: string, path: string) =>
      under ? owner === "" && under.some((p) => path === p || path.startsWith(`${p}/`)) : owner === userId || (owner === "" && !own.has(path));
    const hits = results
      .filter((r) => r.metadata?.embedding_model === this.embeddingModel)
      .map((r) => ({ owner: String(r.metadata?.owner ?? ""), path: String(r.metadata?.path ?? ""), content: r.memory }))
      .filter((h) => fits(h.owner, h.path))
      .slice(0, limit);
    const heads = new Map<string, string>();
    for (const h of hits) {
      const key = `${h.owner}\n${h.path}`;
      if (!heads.has(key)) heads.set(key, (await this.chunks(h.owner)).find((c) => c.path === h.path && c.idx === 0)?.content ?? "");
    }
    return hits.map((h) => ({ ...h, title: titleOf(h.path, heads.get(`${h.owner}\n${h.path}`)) }));
  }

  /** The ids of one owner's documents. */
  private async ids(owner: string): Promise<string[]> {
    return (await this.records.walk(docDir(owner))).filter((id) => DOCUMENT_ID.test(id));
  }

  private async chunkCounts(owner: string): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    for (const c of await this.chunks(owner)) counts.set(c.path, (counts.get(c.path) ?? 0) + 1);
    return counts;
  }

  /** The project's documents and `viewer`'s own, with their chunk counts; a project one the viewer replaced is `overridden`. */
  async listDocuments(viewer = ""): Promise<DocumentSummary[]> {
    const own = viewer ? await this.ids(viewer) : [];
    const out: DocumentSummary[] = [];
    for (const [owner, ids] of [["", await this.ids("")], ...(viewer ? [[viewer, own] as const] : [])] as const) {
      const counts = await this.chunkCounts(owner);
      for (const id of ids) {
        const doc = await this.getDocument(id, owner);
        if (!doc) continue;
        out.push({
          id,
          title: doc.title,
          chunks: counts.get(`${KNOWLEDGE_DIR}/${id}`) ?? 0,
          scope: owner === "" ? "project" : "personal",
          ...(owner === "" && own.includes(id) ? { overridden: true } : {}),
          createdAt: doc.updatedAt,
        });
      }
    }
    return out.sort((a, b) => a.id.localeCompare(b.id) || Number(a.scope === "personal") - Number(b.scope === "personal"));
  }

  /** One owner's document ('' the project's). */
  async getDocument(id: string, owner = ""): Promise<KnowledgeDocument | null> {
    if (!DOCUMENT_ID.test(id)) return null;
    const path = `${docDir(owner)}/${id}`;
    const text = await this.records.readText(path);
    if (text === undefined) return null;
    const { meta, body } = parseFrontmatter(text);
    const modified = (await this.records.modified(path))!.toISOString();
    return { id, owner, title: meta.title || titleOf(id, body), content: body, createdAt: modified, updatedAt: modified };
  }

  /** Saves a document (new or changed) and indexes it; the title defaults to its leading heading or its id. */
  async putDocument(id: string, content: string, title = titleOf(id, content), owner = ""): Promise<void> {
    if (!DOCUMENT_ID.test(id) || id.length > 300) throw new Error(`Invalid document id: ${id}`);
    await this.records.writeText(`${docDir(owner)}/${id}`, formatFrontmatter({ title: title === titleOf(id, content) ? undefined : title }, content));
    await this.indexFile(owner, `${KNOWLEDGE_DIR}/${id}`, content);
  }

  async deleteDocument(id: string, owner = ""): Promise<boolean> {
    if (!DOCUMENT_ID.test(id)) return false;
    const existed = await this.records.remove(`${docDir(owner)}/${id}`);
    await this.removeFile(owner, `${KNOWLEDGE_DIR}/${id}`, false);
    return existed;
  }

  /**
   * Brings the chunks in step with the documents: indexes those without chunks of the current embedding model (new
   * model, a lost cache, an edit outside Osiris) and drops chunks of documents that are gone.
   */
  async reindexStale(): Promise<void> {
    for (const owner of ["", ...(await userIds(this.records))]) {
      const ids = await this.ids(owner);
      const indexed = new Set((await this.chunks(owner)).map((c) => c.path));
      for (const id of ids) {
        if (indexed.delete(`${KNOWLEDGE_DIR}/${id}`)) continue;
        const doc = await this.getDocument(id, owner);
        if (doc) await this.indexFile(owner, `${KNOWLEDGE_DIR}/${id}`, doc.content).catch((err) => console.error(`Indexing ${id} failed`, err));
      }
      for (const gone of indexed) await this.removeFile(owner, gone);
    }
  }
}
