import { randomUUID } from "node:crypto";
import type { EmbeddingsInterface } from "@langchain/core/embeddings";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import type { Client } from "@libsql/client";
import type { DocumentSummary, Scope } from "@osiris/shared";

export interface SearchResult {
  documentId: string;
  title: string;
  content: string;
  distance: number;
}

const splitter = new RecursiveCharacterTextSplitter({ chunkSize: 1000, chunkOverlap: 150 });

/**
 * Knowledge base of one tenant. The tenant boundary is the database itself: each tenant's
 * store is opened on that tenant's own database (see src/tenants/). Within it, documents are
 * tenant-wide (`owner` '') or personal (`owner` = user's sub, searched only for that user).
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

  async addDocument(title: string, content: string, scope: Scope = "tenant", userId = ""): Promise<DocumentSummary> {
    const id = randomUUID();
    const pieces = await splitter.splitText(content);
    const vectors = await this.embeddings.embedDocuments(pieces);
    await this.db.batch(
      [
        { sql: "INSERT INTO documents (id, title, owner) VALUES (?, ?, ?)", args: [id, title, scope === "tenant" ? "" : userId] },
        ...pieces.map((text, idx) => ({
          sql: `INSERT INTO chunks (id, document_id, idx, content, embedding_model, embedding)
                VALUES (?, ?, ?, ?, ?, vector32(?))`,
          args: [randomUUID(), id, idx, text, this.embeddingModel, JSON.stringify(vectors[idx])],
        })),
      ],
      "write",
    );
    return { id, title, chunks: pieces.length, scope, createdAt: new Date().toISOString() };
  }

  /** Searches tenant documents plus `userId`'s personal ones. */
  async search(query: string, userId = "", limit = 5): Promise<SearchResult[]> {
    const vector = await this.embeddings.embedQuery(query);
    const { rows } = await this.db.execute({
      sql: `SELECT c.document_id, d.title, c.content, vector_distance_cos(c.embedding, vector32(?)) AS distance
            FROM chunks c JOIN documents d ON d.id = c.document_id
            WHERE c.embedding_model = ? AND d.owner IN ('', ?)
            ORDER BY distance LIMIT ?`,
      args: [JSON.stringify(vector), this.embeddingModel, userId, limit],
    });
    return rows.map((r) => ({
      documentId: String(r.document_id),
      title: String(r.title),
      content: String(r.content),
      distance: Number(r.distance),
    }));
  }

  /** Tenant documents plus `userId`'s personal ones. */
  async listDocuments(userId = ""): Promise<DocumentSummary[]> {
    const { rows } = await this.db.execute({
      sql: `SELECT d.id, d.title, d.owner, d.created_at, COUNT(c.id) AS chunks
            FROM documents d LEFT JOIN chunks c ON c.document_id = d.id
            WHERE d.owner IN ('', ?) GROUP BY d.id ORDER BY d.created_at DESC, d.rowid DESC`,
      args: [userId],
    });
    return rows.map((r) => ({
      id: String(r.id),
      title: String(r.title),
      chunks: Number(r.chunks),
      scope: r.owner === "" ? "tenant" : "personal",
      createdAt: String(r.created_at),
    }));
  }

  /** Deletes a tenant document (`scope` tenant) or `userId`'s personal one. Returns false if there's no such document. */
  async deleteDocument(id: string, scope: Scope = "tenant", userId = ""): Promise<boolean> {
    const owner = scope === "tenant" ? "" : userId;
    const [, docs] = await this.db.batch(
      [
        { sql: "DELETE FROM chunks WHERE document_id = (SELECT id FROM documents WHERE id = ? AND owner = ?)", args: [id, owner] },
        { sql: "DELETE FROM documents WHERE id = ? AND owner = ?", args: [id, owner] },
      ],
      "write",
    );
    return (docs?.rowsAffected ?? 0) > 0;
  }
}
