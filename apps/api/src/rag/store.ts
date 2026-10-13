import { randomUUID } from "node:crypto";
import type { EmbeddingsInterface } from "@langchain/core/embeddings";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import type { Client } from "@libsql/client";

export interface SearchResult {
  documentId: string;
  title: string;
  content: string;
  distance: number;
}

export interface DocumentSummary {
  id: string;
  title: string;
  chunks: number;
  createdAt: string;
}

const splitter = new RecursiveCharacterTextSplitter({ chunkSize: 1000, chunkOverlap: 150 });

/**
 * Knowledge base of one tenant. The tenant boundary is the database itself: each tenant's
 * store is opened on that tenant's own database (see src/tenants/).
 *
 * Rows record `embeddingModel`, so changing EMBEDDING_MODEL hides old vectors instead of
 * comparing vectors from different models. Re-ingest documents after switching models.
 */
export class KnowledgeStore {
  constructor(
    private readonly db: Client,
    private readonly embeddings: EmbeddingsInterface,
    private readonly embeddingModel: string,
  ) {}

  async addDocument(title: string, content: string): Promise<DocumentSummary> {
    const id = randomUUID();
    const pieces = await splitter.splitText(content);
    const vectors = await this.embeddings.embedDocuments(pieces);
    await this.db.batch(
      [
        { sql: "INSERT INTO documents (id, title) VALUES (?, ?)", args: [id, title] },
        ...pieces.map((text, idx) => ({
          sql: `INSERT INTO chunks (id, document_id, idx, content, embedding_model, embedding)
                VALUES (?, ?, ?, ?, ?, vector32(?))`,
          args: [randomUUID(), id, idx, text, this.embeddingModel, JSON.stringify(vectors[idx])],
        })),
      ],
      "write",
    );
    return { id, title, chunks: pieces.length, createdAt: new Date().toISOString() };
  }

  async search(query: string, limit = 5): Promise<SearchResult[]> {
    const vector = await this.embeddings.embedQuery(query);
    const { rows } = await this.db.execute({
      sql: `SELECT c.document_id, d.title, c.content, vector_distance_cos(c.embedding, vector32(?)) AS distance
            FROM chunks c JOIN documents d ON d.id = c.document_id
            WHERE c.embedding_model = ?
            ORDER BY distance LIMIT ?`,
      args: [JSON.stringify(vector), this.embeddingModel, limit],
    });
    return rows.map((r) => ({
      documentId: String(r.document_id),
      title: String(r.title),
      content: String(r.content),
      distance: Number(r.distance),
    }));
  }

  async listDocuments(): Promise<DocumentSummary[]> {
    const { rows } = await this.db.execute(
      `SELECT d.id, d.title, d.created_at, COUNT(c.id) AS chunks
       FROM documents d LEFT JOIN chunks c ON c.document_id = d.id
       GROUP BY d.id ORDER BY d.created_at DESC`,
    );
    return rows.map((r) => ({ id: String(r.id), title: String(r.title), chunks: Number(r.chunks), createdAt: String(r.created_at) }));
  }

  /** Returns false if the document doesn't exist. */
  async deleteDocument(id: string): Promise<boolean> {
    const [, docs] = await this.db.batch(
      [
        { sql: "DELETE FROM chunks WHERE document_id = ?", args: [id] },
        { sql: "DELETE FROM documents WHERE id = ?", args: [id] },
      ],
      "write",
    );
    return (docs?.rowsAffected ?? 0) > 0;
  }
}
