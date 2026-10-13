import { describe, expect, it } from "vitest";
import { KnowledgeStore } from "../src/rag/store.ts";
import { createTestDb, WordEmbeddings } from "./helpers.ts";

async function setup() {
  const db = await createTestDb();
  return { db, store: new KnowledgeStore(db, new WordEmbeddings(), "test:words") };
}

describe("KnowledgeStore", () => {
  it("ranks the most similar chunk first", async () => {
    const { store } = await setup();
    await store.addDocument("Novák", "Pan Novák chce rekonstrukci koupelny, obklad bílý.");
    await store.addDocument("Ceník", "Hodinová sazba elektrikáře je 650 Kč.");

    const [top] = await store.search("kolik stojí hodinová sazba");
    expect(top?.title).toBe("Ceník");
  });

  it("ignores vectors from a different embedding model", async () => {
    const { db, store } = await setup();
    await store.addDocument("Doc", "obsah dokumentu");

    const other = new KnowledgeStore(db, new WordEmbeddings(), "test:other");
    expect(await other.search("obsah")).toEqual([]);
  });

  it("deletes a document with its chunks", async () => {
    const { store } = await setup();
    const doc = await store.addDocument("Doc", "obsah");

    expect(await store.deleteDocument("missing")).toBe(false);
    expect(await store.deleteDocument(doc.id)).toBe(true);
    expect(await store.search("obsah")).toEqual([]);
    expect(await store.listDocuments()).toEqual([]);
  });
});
