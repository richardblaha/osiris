import { describe, expect, it } from "vitest";
import { createTestApp, createTestDb, createTestTenants } from "./helpers.ts";
import { joinChunks, moveLegacyToFiles } from "@osiris/core/files/sync.ts";
import { FileStore } from "@osiris/core/files/store.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const text = (s: string) => Buffer.from(s);

describe("knowledge base", () => {
  it("keeps documents in the database, indexed as they're saved, and finds them by meaning and by words", async () => {
    const { tenants } = createTestTenants();
    const acme = await tenants.get("acme");
    await acme.knowledge.putDocument("novak.md", "Pan Novák chce rekonstrukci koupelny, obklad bílý.");
    await acme.knowledge.putDocument("public/cenik.md", "# Ceník\n\nHodinová sazba elektrikáře je 650 Kč, víkend dvojnásobně.");
    // A file is only full-text searchable, never knowledge.
    await acme.files.write({ scope: "tenant" }, "knowledge/stary.md", text("Sazba DPH 21 %"));

    const [top] = await acme.knowledge.search("kolik stojí hodinová sazba");
    expect(top).toMatchObject({ title: "Ceník", path: "knowledge/public/cenik.md", owner: "" });
    expect((await acme.knowledge.search("vikend")).map((r) => r.path)[0]).toBe("knowledge/public/cenik.md");
    expect((await acme.knowledge.search("DPH")).map((r) => r.path)).not.toContain("knowledge/stary.md");
    expect((await acme.knowledge.listDocuments()).map((d) => [d.id, d.title, d.chunks])).toEqual([
      ["novak.md", "novak", 1],
      ["public/cenik.md", "Ceník", 1],
    ]);

    await acme.knowledge.putDocument("public/cenik.md", "Montáž zásuvky stojí 300 Kč.", "Ceník");
    expect((await acme.knowledge.search("hodinová sazba elektrikáře")).map((r) => r.content).join()).not.toContain("Hodinová");
    expect(await acme.knowledge.deleteDocument("public/cenik.md")).toBe(true);
    expect((await acme.knowledge.search("zásuvky")).map((r) => r.path)).toEqual(["knowledge/novak.md"]);
    await expect(acme.knowledge.putDocument("../x.md", "x")).rejects.toThrow();
  });

  it("serves documents to the tenant's people", async () => {
    const { tenants } = createTestTenants();
    const app = await createTestApp(tenants);
    const bob = (path: string, init: RequestInit = {}) =>
      app.request(`/api${path}`, { ...init, headers: { authorization: "Bearer bob:tenant=acme", "x-tenant-id": "acme", "content-type": "application/json" } });
    const created = await (await bob("/knowledge/documents", { method: "POST", body: JSON.stringify({ title: "Ceník služeb", content: "650 Kč", folder: "public" }) })).json();
    expect(created).toMatchObject({ id: "public/cenik-sluzeb.md", title: "Ceník služeb", chunks: 1 });
    expect((await (await bob("/knowledge/documents/public/cenik-sluzeb.md")).json()).content).toBe("650 Kč");
    expect((await bob("/knowledge/documents/public/cenik-sluzeb.md", { method: "PUT", body: JSON.stringify({ title: "Ceník", content: "700 Kč" }) })).status).toBe(200);
    expect((await (await bob("/knowledge/documents")).json()).map((d: { title: string }) => d.title)).toEqual(["Ceník"]);
    expect((await bob("/knowledge/documents/public/cenik-sluzeb.md", { method: "DELETE" })).status).toBe(204);
    expect((await bob("/knowledge/documents/public/cenik-sluzeb.md")).status).toBe(404);
  });

  it("moves the files once in knowledge/ into documents, once", async () => {
    const { tenants } = createTestTenants();
    const acme = await tenants.get("acme");
    await acme.files.write({ scope: "tenant" }, "knowledge/public/cenik.md", text("# Ceník\n\n650 Kč"));
    await acme.files.write({ scope: "tenant" }, "knowledge/plán zakázek.md", text("Brno v pondělí"));
    await acme.files.write({ scope: "tenant" }, "knowledge/foto.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    await acme.init();
    expect((await acme.knowledge.listDocuments()).map((d) => [d.id, d.title, d.chunks])).toEqual([
      ["plán-zakázek.md", "plán zakázek", 1],
      ["public/cenik.md", "Ceník", 1],
    ]);
    expect((await acme.files.list({ scope: "tenant" }, "knowledge")).map((e) => e.name)).toEqual(["public", "foto.png"]);
    expect((await acme.knowledge.search("Brno")).map((r) => r.path)[0]).toBe("knowledge/plán-zakázek.md");
  });

  it("searches all text files by words, with a snippet", async () => {
    const { tenants } = createTestTenants();
    const acme = await tenants.get("acme");
    await acme.files.write({ scope: "tenant" }, "sablony/nabidka.md", text("Cenová nabídka na elektroinstalaci v Brně"));
    await acme.files.write({ scope: "personal", userId: "bob" }, "poznamky.txt", text("Zavolat panu Dvořákovi kvůli elektroinstalaci"));
    expect(await acme.fileIndex.search("elektroinstal brne", ["", "bob"])).toEqual([
      { owner: "", path: "sablony/nabidka.md", snippet: "Cenová nabídka na «elektroinstalaci» v «Brně»" },
    ]);
    expect((await acme.fileIndex.search("elektroinstalaci", ["", "bob"])).map((h) => h.path).sort()).toEqual(["poznamky.txt", "sablony/nabidka.md"]);
    expect((await acme.fileIndex.search("elektroinstalaci", [""])).map((h) => h.path)).toEqual(["sablony/nabidka.md"]);
  });

  it("indexes documents again whose chunks are gone (a new embedding model, a restore)", async () => {
    const { tenants } = createTestTenants();
    const acme = await tenants.get("acme");
    await acme.knowledge.putDocument("a.md", "stará verze");
    await acme.files.write({ scope: "tenant" }, "poznamky/a.md", text("stará verze"));
    await acme.db.batch(["DELETE FROM indexed_files", "DELETE FROM file_text", "DELETE FROM knowledge_chunks", "DELETE FROM knowledge_text"], "write");
    await acme.init();
    expect((await acme.knowledge.search("verze")).map((r) => r.path)).toEqual(["knowledge/a.md"]);
    expect((await acme.fileIndex.search("verze", [""])).map((h) => h.path)).toEqual(["poznamky/a.md"]);
  });

  it("moves documents and skills from old tables to files, rebuilding documents from overlapping chunks", async () => {
    expect(joinChunks(["Jedna dvě tři čtyři", "tři čtyři pět šest", "zcela jiný"])).toBe("Jedna dvě tři čtyři pět šest\n\nzcela jiný");
    const db = await createTestDb();
    await db.batch(
      [
        // The tables as the earlier migrations left them.
        "INSERT INTO documents (id, title, owner) VALUES ('d1', 'Ceník služeb', ''), ('d2', 'Moje', 'bob')",
        `INSERT INTO chunks (id, document_id, idx, content, embedding_model, embedding) VALUES
           ('c1', 'd1', 0, 'Hodina práce 650 Kč', 'm', x''), ('c2', 'd1', 1, '650 Kč a doprava 10 Kč/km', 'm', x''), ('c3', 'd2', 0, 'osobní', 'm', x'')`,
        "INSERT INTO skills (owner, name, description, instructions) VALUES ('', 'faktura', 'Jak psát faktury', 'Krok 1.'), ('bob', 'moje', 'Bobova', 'Krok A.')",
      ],
      "write",
    );
    const files = new FileStore(mkdtempSync(join(tmpdir(), "osiris-legacy-")));
    await moveLegacyToFiles(db, files);
    expect((await files.read({ scope: "tenant" }, "knowledge/cenik-sluzeb.md")).data.toString()).toBe("# Ceník služeb\n\nHodina práce 650 Kč a doprava 10 Kč/km\n");
    expect((await files.read({ scope: "personal", userId: "bob" }, "knowledge/moje.md")).data.toString()).toContain("osobní");
    expect((await files.read({ scope: "tenant" }, "skills/faktura/SKILL.md")).data.toString()).toBe(
      "---\nname: faktura\ndescription: Jak psát faktury\n---\n\nKrok 1.\n",
    );
    expect((await files.read({ scope: "personal", userId: "bob" }, "skills/moje/SKILL.md")).data.toString()).toContain("Krok A.");
    const tables = (await db.execute("SELECT name FROM sqlite_master WHERE name IN ('documents', 'chunks', 'skills')")).rows;
    expect(tables).toEqual([]);
  });
});
