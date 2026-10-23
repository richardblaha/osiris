import { fileType } from "@osiris/shared";
import type { FileIndex } from "./index.ts";
import type { FileChange, FileLocation, FileStore } from "./store.ts";

/** Larger text files are stored but not indexed. */
const MAX_INDEXED_BYTES = 1024 * 1024;

const ownerOf = (loc: FileLocation) => (loc.scope === "personal" ? loc.userId : "");
const locOf = (owner: string): FileLocation => (owner ? { scope: "personal", userId: owner } : { scope: "project" });

/**
 * Keeps the full-text index in step with the files: every change the file store makes goes through `apply`, and
 * `reconcile` catches up with what changed on disk otherwise (a restored snapshot).
 */
export class FileIndexer {
  constructor(
    private readonly files: FileStore,
    private readonly index: FileIndex,
  ) {}

  apply = async (change: FileChange) => {
    const owner = ownerOf(change.loc);
    if (change.kind === "delete") {
      await this.index.remove(owner, change.path);
      return;
    }
    // A written file, or a folder moved in: everything under it.
    for await (const entry of this.files.walk(change.loc, change.path)) await this.indexFile(owner, entry.path, entry.modifiedAt);
  };

  private async indexFile(owner: string, path: string, modifiedAt: string) {
    const loc = locOf(owner);
    const { entry, data } = await this.files.read(loc, path);
    if (!fileType(path)?.text || entry.size > MAX_INDEXED_BYTES) return;
    await this.index.put(owner, path, data.toString("utf8"), Date.parse(modifiedAt));
  }

  /** Indexes files changed since they were indexed and drops those that are gone. */
  async reconcile() {
    const owners = new Set(["", ...(await this.files.personalOwners()), ...(await this.index.owners())]);
    for (const owner of owners) {
      const known = await this.index.modified(owner);
      for await (const entry of this.files.walk(locOf(owner))) {
        const modified = Date.parse(entry.modifiedAt);
        const indexed = known.get(entry.path);
        known.delete(entry.path);
        if (indexed === modified || !fileType(entry.path)?.text || entry.size > MAX_INDEXED_BYTES) continue;
        await this.indexFile(owner, entry.path, entry.modifiedAt).catch((err) => console.error(`Indexing ${entry.path} failed`, err));
      }
      for (const gone of known.keys()) await this.index.remove(owner, gone);
    }
  }
}

/** A file name from a title: letters, digits and dashes, without diacritics. */
export const slug = (title: string) =>
  title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80) || "dokument";
