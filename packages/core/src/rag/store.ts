import type { EmbeddingsInterface } from "@langchain/core/embeddings";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import type { Client } from "@libsql/client";
import type { DocumentSummary } from "@osiris/shared";
import { ftsQuery } from "../files/index.ts";

/** Where the knowledge base lives in the tenant's and each user's files. */
export const KNOWLEDGE_DIR = "knowledge";

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
 * The knowledge base: the files in `knowledge/` of the tenant (owner '') and of each user (their sub, searched only
 * for them). The files are the truth; this keeps their chunks with vectors and text, updated whenever a file changes.
 * Search combines vector similarity with full-text matches.
 *
 * Chunks record `embeddingModel`, so changing EMBEDDING_MODEL hides old vectors until the files are indexed again.
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

  /** Searches the tenant's files plus `userId`'s own: by meaning (vectors) and by words (full text), merged. */
  async search(query: string, userId = "", limit = 5): Promise<SearchResult[]> {
    const vector = await this.embeddings.embedQuery(query);
    const { rows: near } = await this.db.execute({
      sql: `SELECT id FROM knowledge_chunks WHERE embedding_model = ? AND owner IN ('', ?)
            ORDER BY vector_distance_cos(embedding, vector32(?)) LIMIT 20`,
      args: [this.embeddingModel, userId, JSON.stringify(vector)],
    });
    const match = ftsQuery(query, "OR");
    const { rows: words } = match
      ? await this.db.execute({
          sql: `SELECT c.id FROM knowledge_text t JOIN knowledge_chunks c ON c.id = t.rowid
                WHERE knowledge_text MATCH ? AND c.owner IN ('', ?) ORDER BY bm25(knowledge_text) LIMIT 20`,
          args: [match, userId],
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

  /** The knowledge base's files: the tenant's and `userId`'s own, with their chunk counts. */
  async listDocuments(userId = ""): Promise<DocumentSummary[]> {
    const { rows } = await this.db.execute({
      sql: `SELECT f.owner, f.path, f.modified,
              (SELECT COUNT(*) FROM knowledge_chunks c WHERE c.owner = f.owner AND c.path = f.path) AS chunks,
              (SELECT content FROM knowledge_chunks c WHERE c.owner = f.owner AND c.path = f.path AND c.idx = 0) AS head
            FROM indexed_files f WHERE f.owner IN ('', ?) AND f.path LIKE ? ORDER BY f.path`,
      args: [userId, `${KNOWLEDGE_DIR}/%`],
    });
    return rows.map((r) => ({
      id: String(r.path).slice(KNOWLEDGE_DIR.length + 1),
      title: titleOf(String(r.path), String(r.head ?? "")),
      chunks: Number(r.chunks),
      scope: r.owner === "" ? "tenant" : "personal",
      createdAt: new Date(Number(r.modified)).toISOString(),
    }));
  }
}
