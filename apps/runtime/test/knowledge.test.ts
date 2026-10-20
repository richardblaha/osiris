import { describe, expect, it } from "vitest";
import { createTestDb, createTestTenants } from "./helpers.ts";
import { joinChunks, moveLegacyToFiles } from "@osiris/core/files/sync.ts";
import { FileStore } from "@osiris/core/files/store.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const text = (s: string) => Buffer.from(s);

describe("knowledge base in files", () => {
  it("indexes files in knowledge/ as they're written and finds them by meaning and by words", async () => {
    const { tenants } = createTestTenants();
    const acme = await tenants.get("acme");
    await acme.files.write({ scope: "tenant" }, "knowledge/novak.md", text("Pan Novák chce rekonstrukci koupelny, obklad bílý."));
    await acme.files.write({ scope: "tenant" }, "knowledge/cenik.md", text("Hodinová sazba elektrikáře je 650 Kč."));
    await acme.files.write({ scope: "personal", userId: "bob" }, "knowledge/poznamka.md", text("Bobova sazba za víkend je dvojnásobná."));
    // Outside knowledge/ a file is only full-text searchable.
    await acme.files.write({ scope: "tenant" }, "sablony/faktura.html", text("<p>Sazba DPH 21 %</p>"));

    const [top] = await acme.knowledge.search("kolik stojí hodinová sazba");
    expect(top).toMatchObject({ title: "cenik", path: "knowledge/cenik.md", owner: "" });
    // Words without diacritics still match (full text), and personal files only for their owner.
    expect((await acme.knowledge.search("vikend", "bob")).map((r) => r.path)).toContain("knowledge/poznamka.md");
    expect((await acme.knowledge.search("vikend", "eva")).map((r) => r.path)).not.toContain("knowledge/poznamka.md");
    expect((await acme.knowledge.listDocuments("bob")).map((d) => [d.id, d.scope])).toEqual([
      ["cenik.md", "tenant"],
      ["novak.md", "tenant"],
      ["poznamka.md", "personal"],
    ]);

    // Editing, moving and deleting files keeps the index in step.
    await acme.files.write({ scope: "tenant" }, "knowledge/cenik.md", text("Montáž zásuvky stojí 300 Kč."));
    expect((await acme.knowledge.search("hodinová sazba elektrikáře")).map((r) => r.content).join()).not.toContain("Hodinová");
    await acme.files.move({ scope: "tenant" }, "knowledge/novak.md", { scope: "tenant" }, "archiv/novak.md");
    expect((await acme.knowledge.listDocuments()).map((d) => d.id)).toEqual(["cenik.md"]);
    expect((await acme.fileIndex.search("koupelny", [""])).map((h) => h.path)).toEqual(["archiv/novak.md"]);
    await acme.files.delete({ scope: "tenant" }, "knowledge");
    expect(await acme.knowledge.search("zásuvky")).toEqual([]);
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

  it("catches up with files changed on disk, e.g. after a restore", async () => {
    const { tenants } = createTestTenants();
    const acme = await tenants.get("acme");
    await acme.files.write({ scope: "tenant" }, "knowledge/a.md", text("stará verze"));
    // The index is lost (a restored database without it), the files stay.
    await acme.db.batch(["DELETE FROM indexed_files", "DELETE FROM file_text", "DELETE FROM knowledge_chunks", "DELETE FROM knowledge_text"], "write");
    await acme.init();
    expect((await acme.knowledge.search("verze")).map((r) => r.path)).toEqual(["knowledge/a.md"]);
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
