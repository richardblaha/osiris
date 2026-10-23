import { describe, expect, it } from "vitest";
import { createTestApp, createTestRecords, createTestProjects } from "./helpers.ts";
import { FileStore } from "@osiris/core/files/store.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const text = (s: string) => Buffer.from(s);

describe("knowledge base", () => {
  it("keeps documents in the database, indexed as they're saved, and finds them by meaning and by words", async () => {
    const { projects } = createTestProjects();
    const acme = await projects.get("acme");
    await acme.knowledge.putDocument("novak.md", "Pan Novák chce rekonstrukci koupelny, obklad bílý.");
    await acme.knowledge.putDocument("public/cenik.md", "# Ceník\n\nHodinová sazba elektrikáře je 650 Kč, víkend dvojnásobně.");
    // A file is only full-text searchable, never knowledge.
    await acme.files.write({ scope: "project" }, "knowledge/stary.md", text("Sazba DPH 21 %"));

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

  it("gives a user their own documents, which replace the project's of the same id for them alone", async () => {
    const { projects } = createTestProjects();
    const acme = await projects.get("acme");
    await acme.knowledge.putDocument("cenik.md", "Hodinová sazba elektrikáře je 650 Kč.");
    await acme.knowledge.putDocument("cenik.md", "Moje hodinová sazba elektrikáře je 700 Kč.", undefined, "bob");
    await acme.knowledge.putDocument("poznamky.md", "Bobova poznámka o rozvaděči.", undefined, "bob");

    const found = async (user: string, query: string) => (await acme.knowledge.search(query, user)).map((r) => `${r.owner || "project"}:${r.content}`);
    // Vector search returns the nearest of what the user may see, however far: the project's price list isn't among Bob's.
    expect(await found("bob", "hodinová sazba elektrikáře")).toEqual(["bob:Moje hodinová sazba elektrikáře je 700 Kč.", "bob:Bobova poznámka o rozvaděči."]);
    expect(await found("carol", "hodinová sazba elektrikáře")).toEqual(["project:Hodinová sazba elektrikáře je 650 Kč."]);
    // A public assistant only ever searches the project's.
    expect((await acme.knowledge.search("sazba", "", 5, { under: ["knowledge/cenik.md"] })).map((r) => r.content)).toEqual(["Hodinová sazba elektrikáře je 650 Kč."]);
    expect(await acme.knowledge.deleteDocument("cenik.md", "bob")).toBe(true);
    expect((await found("bob", "hodinová sazba elektrikáře"))[0]).toBe("project:Hodinová sazba elektrikáře je 650 Kč.");
  });

  it("serves documents to the project's people", async () => {
    const { projects } = createTestProjects();
    const app = await createTestApp(projects);
    const bob = (path: string, init: RequestInit = {}) =>
      app.request(`/api${path}`, { ...init, headers: { authorization: "Bearer bob:project=acme", "x-project-id": "acme", "content-type": "application/json" } });
    const created = await (await bob("/knowledge/documents", { method: "POST", body: JSON.stringify({ title: "Ceník služeb", content: "650 Kč", folder: "public" }) })).json();
    expect(created).toMatchObject({ id: "public/cenik-sluzeb.md", title: "Ceník služeb", chunks: 1 });
    expect((await (await bob("/knowledge/documents/public/cenik-sluzeb.md")).json()).content).toBe("650 Kč");
    expect((await bob("/knowledge/documents/public/cenik-sluzeb.md", { method: "PUT", body: JSON.stringify({ title: "Ceník", content: "700 Kč" }) })).status).toBe(200);
    expect((await (await bob("/knowledge/documents")).json()).map((d: { title: string }) => d.title)).toEqual(["Ceník"]);
    expect((await bob("/knowledge/documents/public/cenik-sluzeb.md", { method: "DELETE" })).status).toBe(204);
    expect((await bob("/knowledge/documents/public/cenik-sluzeb.md")).status).toBe(404);
  });

  it("searches all text files by words, with a snippet", async () => {
    const { projects } = createTestProjects();
    const acme = await projects.get("acme");
    await acme.files.write({ scope: "project" }, "sablony/nabidka.md", text("Cenová nabídka na elektroinstalaci v Brně"));
    await acme.files.write({ scope: "personal", userId: "bob" }, "poznamky.txt", text("Zavolat panu Dvořákovi kvůli elektroinstalaci"));
    expect(await acme.fileIndex.search("elektroinstal brne", ["", "bob"])).toEqual([
      { owner: "", path: "sablony/nabidka.md", snippet: "Cenová nabídka na «elektroinstalaci» v «Brně»" },
    ]);
    expect((await acme.fileIndex.search("elektroinstalaci", ["", "bob"])).map((h) => h.path).sort()).toEqual(["poznamky.txt", "sablony/nabidka.md"]);
    expect((await acme.fileIndex.search("elektroinstalaci", [""])).map((h) => h.path)).toEqual(["sablony/nabidka.md"]);
  });

  it("indexes documents again whose chunks are gone (a new embedding model, a restore)", async () => {
    const { projects } = createTestProjects();
    const acme = await projects.get("acme");
    await acme.knowledge.putDocument("a.md", "stará verze");
    await acme.files.write({ scope: "project" }, "poznamky/a.md", text("stará verze"));
    await acme.cache.batch(["DELETE FROM indexed_files", "DELETE FROM file_text", "DELETE FROM knowledge_chunks", "DELETE FROM knowledge_text"], "write");
    await acme.init();
    expect((await acme.knowledge.search("verze")).map((r) => r.path)).toEqual(["knowledge/a.md"]);
    expect((await acme.fileIndex.search("verze", [""])).map((h) => h.path)).toEqual(["poznamky/a.md"]);
  });
});
