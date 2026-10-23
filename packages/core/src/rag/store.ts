import type { EmbeddingsInterface } from "@langchain/core/embeddings";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import type { Client } from "@libsql/client";
import type { DocumentSummary } from "@osiris/shared";
import { ftsQuery } from "../files/index.ts";

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
/** Reciprocal rank fusion: a chunk's score from its rank in each list, so vector and word matches add up. */
const RRF_K = 60;

/** A document's title: its leading Markdown heading, or the file's name. */
export const titleOf = (path: string, text = "") => /^#\s+(.+)/.exec(text.trimStart())?.[1]?.trim() || (path.split("/").at(-1) ?? path).replace(/\.[^.]+$/, "");

/**
 * The knowledge base: the project's documents (`knowledge_documents`) with their chunks' vectors and text, indexed as
 * a document is saved. Search combines vector similarity with full-text matches.
 *
 * Chunks record `embeddingModel`, so changing EMBEDDING_MODEL hides old vectors until `reindexStale` (at startup).
 */
export class KnowledgeStore {
  constructor(
    private readonly db: Client,
    private readonly embeddings: EmbeddingsInterface,
    private readonly embeddingModel: string,
  ) {}

  /** (Re)indexes one file of the knowledge base. */
  async indexFile(owner: string, path: string, content: string): Promise<void> {
    const pieces = (await splitter.splitText(content)).filter((p) => p.trim());
    const vectors = pieces.length ? await this.embeddings.embedDocuments(pieces) : [];
    await this.db.batch(
      [
        ...this.removing(owner, path, false),
        ...pieces.flatMap((text, idx) => [
          {
            sql: `INSERT INTO knowledge_chunks (owner, path, idx, content, embedding_model, embedding) VALUES (?, ?, ?, ?, ?, vector32(?))`,
            args: [owner, path, idx, text, this.embeddingModel, JSON.stringify(vectors[idx])],
          },
          { sql: "INSERT INTO knowledge_text (rowid, content) VALUES (last_insert_rowid(), ?)", args: [text] },
        ]),
      ],
      "write",
    );
  }

  /** Drops a file's chunks, or those of every file under a folder. */
  async removeFile(owner: string, path: string): Promise<void> {
    await this.db.batch(this.removing(owner, path, true), "write");
  }

  private removing(owner: string, path: string, folder: boolean) {
    const where = folder ? "owner = ? AND (path = ? OR path LIKE ?)" : "owner = ? AND path = ?";
    const args = folder ? [owner, path, `${path}/%`] : [owner, path];
    return [
      { sql: `DELETE FROM knowledge_text WHERE rowid IN (SELECT id FROM knowledge_chunks WHERE ${where})`, args },
      { sql: `DELETE FROM knowledge_chunks WHERE ${where}`, args },
    ];
  }

  /**
   * Searches the project's documents plus `userId`'s own, by meaning (vectors) and by words (full text), merged. A
   * project document the user has their own copy of (same id) is left out: theirs replaces it for them.
   */
  async search(query: string, userId = "", limit = 5, { under }: { under?: string[] } = {}): Promise<SearchResult[]> {
    // `under`: only the project's files that are these files or in these folders (a public assistant's knowledge).
    if (under && !under.length) return [];
    const scope = under
      ? `owner = '' AND (${under.map(() => "path = ? OR substr(path, 1, length(?)) = ?").join(" OR ")})`
      : "(owner = ? OR (owner = '' AND path NOT IN (SELECT o.path FROM knowledge_chunks o WHERE o.owner = ?)))";
    const scopeArgs = under ? under.flatMap((p) => [p, `${p}/`, `${p}/`]) : [userId, userId];
    const vector = await this.embeddings.embedQuery(query);
    const { rows: near } = await this.db.execute({
      sql: `SELECT id FROM knowledge_chunks WHERE embedding_model = ? AND ${scope}
            ORDER BY vector_distance_cos(embedding, vector32(?)) LIMIT 20`,
      args: [this.embeddingModel, ...scopeArgs, JSON.stringify(vector)],
    });
    const match = ftsQuery(query, "OR");
    const { rows: words } = match
      ? await this.db.execute({
          sql: `SELECT c.id FROM knowledge_text t JOIN knowledge_chunks c ON c.id = t.rowid
                WHERE knowledge_text MATCH ? AND ${scope.replace(/(?<![.\w])(owner|path)\b/g, "c.$1")} ORDER BY bm25(knowledge_text) LIMIT 20`,
          args: [match, ...scopeArgs],
        })
      : { rows: [] };
    const score = new Map<number, number>();
    for (const list of [near, words]) list.forEach((r, rank) => score.set(Number(r.id), (score.get(Number(r.id)) ?? 0) + 1 / (RRF_K + rank + 1)));
    const best = [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([id]) => id);
    if (!best.length) return [];
    const { rows } = await this.db.execute({
      sql: `SELECT c.id, c.owner, c.path, c.content, (SELECT h.content FROM knowledge_chunks h WHERE h.owner = c.owner AND h.path = c.path AND h.idx = 0) AS head
            FROM knowledge_chunks c WHERE c.id IN (${best.map(() => "?").join(", ")})`,
      args: best,
    });
    const byId = new Map(rows.map((r) => [Number(r.id), r]));
    return best.flatMap((id) => {
      const r = byId.get(id);
      return r ? [{ owner: String(r.owner), path: String(r.path), title: titleOf(String(r.path), String(r.head ?? "")), content: String(r.content) }] : [];
    });
  }

  /** The project's documents and `viewer`'s own, with their chunk counts; a project one the viewer replaced is `overridden`. */
  async listDocuments(viewer = ""): Promise<DocumentSummary[]> {
    const { rows } = await this.db.execute({
      sql: `SELECT d.owner, d.id, d.title, d.updated_at,
              (SELECT COUNT(*) FROM knowledge_chunks c WHERE c.owner = d.owner AND c.path = '${KNOWLEDGE_DIR}/' || d.id) AS chunks,
              (d.owner = '' AND ? <> '' AND EXISTS (SELECT 1 FROM knowledge_documents m WHERE m.owner = ? AND m.id = d.id)) AS overridden
            FROM knowledge_documents d WHERE d.owner IN ('', ?) ORDER BY d.id, d.owner <> ''`,
      args: [viewer, viewer, viewer],
    });
    return rows.map((r) => ({
      id: String(r.id),
      title: String(r.title),
      chunks: Number(r.chunks),
      scope: r.owner === "" ? "project" : "personal",
      ...(Number(r.overridden) ? { overridden: true } : {}),
      createdAt: new Date(`${String(r.updated_at).replace(" ", "T")}Z`).toISOString(),
    }));
  }

  /** One owner's document ('' the project's). */
  async getDocument(id: string, owner = ""): Promise<KnowledgeDocument | null> {
    const { rows } = await this.db.execute({ sql: "SELECT * FROM knowledge_documents WHERE owner = ? AND id = ?", args: [owner, id] });
    const r = rows[0];
    return r ? { id: String(r.id), owner, title: String(r.title), content: String(r.content), createdAt: String(r.created_at), updatedAt: String(r.updated_at) } : null;
  }

  /** Saves a document (new or changed) and indexes it; the title defaults to its leading heading or its id. */
  async putDocument(id: string, content: string, title = titleOf(id, content), owner = ""): Promise<void> {
    if (!DOCUMENT_ID.test(id) || id.length > 300) throw new Error(`Invalid document id: ${id}`);
    await this.db.execute({
      sql: `INSERT INTO knowledge_documents (owner, id, title, content) VALUES (?, ?, ?, ?)
            ON CONFLICT (owner, id) DO UPDATE SET title = excluded.title, content = excluded.content, updated_at = datetime('now')`,
      args: [owner, id, title, content],
    });
    await this.indexFile(owner, `${KNOWLEDGE_DIR}/${id}`, content);
  }

  async deleteDocument(id: string, owner = ""): Promise<boolean> {
    const [r] = await this.db.batch([{ sql: "DELETE FROM knowledge_documents WHERE owner = ? AND id = ?", args: [owner, id] }, ...this.removing(owner, `${KNOWLEDGE_DIR}/${id}`, false)], "write");
    return r!.rowsAffected > 0;
  }

  /** Indexes the documents without chunks of the current embedding model (new model, or never indexed). */
  async reindexStale(): Promise<void> {
    const { rows } = await this.db.execute({
      sql: `SELECT owner, id, content FROM knowledge_documents d WHERE NOT EXISTS
              (SELECT 1 FROM knowledge_chunks c WHERE c.owner = d.owner AND c.path = '${KNOWLEDGE_DIR}/' || d.id AND c.embedding_model = ?)`,
      args: [this.embeddingModel],
    });
    for (const r of rows) {
      await this.indexFile(String(r.owner), `${KNOWLEDGE_DIR}/${String(r.id)}`, String(r.content)).catch((err) => console.error(`Indexing ${String(r.id)} failed`, err));
    }
  }
}
