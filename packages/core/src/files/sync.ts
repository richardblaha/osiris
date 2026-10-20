import type { Client } from "@libsql/client";
import { fileType } from "@osiris/shared";
import { formatSkill, parseSkill, SKILLS_DIR } from "../agent/skills.ts";
import { KNOWLEDGE_DIR, type KnowledgeStore } from "../rag/store.ts";
import type { FileIndex } from "./index.ts";
import type { FileChange, FileLocation, FileStore } from "./store.ts";

/** Larger text files are stored but not indexed. */
const MAX_INDEXED_BYTES = 1024 * 1024;

const ownerOf = (loc: FileLocation) => (loc.scope === "personal" ? loc.userId : "");
const locOf = (owner: string): FileLocation => (owner ? { scope: "personal", userId: owner } : { scope: "tenant" });
const inKnowledge = (path: string) => path === KNOWLEDGE_DIR || path.startsWith(`${KNOWLEDGE_DIR}/`);

/**
 * Keeps the full-text index and the knowledge base's chunks in step with the files: every change the file store
 * makes goes through `apply`, and `reconcile` catches up with what changed on disk otherwise (a restored snapshot).
 */
export class FileIndexer {
  constructor(
    private readonly files: FileStore,
    private readonly index: FileIndex,
    private readonly knowledge: KnowledgeStore,
  ) {}

  apply = async (change: FileChange) => {
    const owner = ownerOf(change.loc);
    if (change.kind === "delete") {
      await this.index.remove(owner, change.path);
      if (inKnowledge(change.path)) await this.knowledge.removeFile(owner, change.path);
      return;
    }
    // A written file, or a folder moved in: everything under it.
    for await (const entry of this.files.walk(change.loc, change.path)) await this.indexFile(owner, entry.path, entry.modifiedAt);
  };

  private async indexFile(owner: string, path: string, modifiedAt: string) {
    const loc = locOf(owner);
    const { entry, data } = await this.files.read(loc, path);
    if (!fileType(path)?.text || entry.size > MAX_INDEXED_BYTES) return;
    const text = data.toString("utf8");
    if (inKnowledge(path)) await this.knowledge.indexFile(owner, path, text);
    await this.index.put(owner, path, text, Date.parse(modifiedAt));
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
      for (const gone of known.keys()) {
        await this.index.remove(owner, gone);
        if (inKnowledge(gone)) await this.knowledge.removeFile(owner, gone);
      }
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

/** Chunks were split with an overlap: each starts with up to the last 150 characters of the one before. */
export function joinChunks(chunks: string[]): string {
  let text = chunks[0] ?? "";
  for (const next of chunks.slice(1)) {
    let k = Math.min(200, text.length, next.length);
    while (k > 0 && !text.endsWith(next.slice(0, k))) k--;
    text += k > 0 ? next.slice(k) : `\n\n${next}`;
  }
  return text;
}

const tableExists = async (db: Client, name: string) =>
  (await db.execute({ sql: "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", args: [name] })).rows.length > 0;

/**
 * Moves what the database used to hold into files, once: knowledge documents (rebuilt from their chunks) to
 * `knowledge/<title>.md` and skills to `skills/<name>/SKILL.md`, each in the tenant's or its owner's files. The old
 * tables are dropped afterwards.
 */
export async function moveLegacyToFiles(db: Client, files: FileStore) {
  if (await tableExists(db, "documents")) {
    const { rows: docs } = await db.execute("SELECT id, title, owner FROM documents ORDER BY created_at");
    for (const d of docs) {
      const { rows } = await db.execute({ sql: "SELECT content FROM chunks WHERE document_id = ? ORDER BY idx", args: [String(d.id)] });
      const loc = locOf(String(d.owner));
      let path = `${KNOWLEDGE_DIR}/${slug(String(d.title))}.md`;
      for (let n = 2; await files.read(loc, path).then(() => true, () => false); n++) path = `${KNOWLEDGE_DIR}/${slug(String(d.title))}-${n}.md`;
      await files.write(loc, path, Buffer.from(`# ${d.title}\n\n${joinChunks(rows.map((r) => String(r.content)))}\n`));
    }
    await db.batch(["DROP TABLE chunks", "DROP TABLE documents"], "write");
  }
  if (await tableExists(db, "skills")) {
    const { rows } = await db.execute("SELECT owner, name, description, instructions FROM skills");
    for (const r of rows) {
      const skill = { name: String(r.name), description: String(r.description), instructions: String(r.instructions) };
      await files.write(locOf(String(r.owner)), `${SKILLS_DIR}/${skill.name}/SKILL.md`, Buffer.from(formatSkill(skill)));
    }
    await db.execute("DROP TABLE skills");
  }
}

/**
 * Settings are the tenant's, not the users' (only the assistant's persona stays personal): moves what users kept for
 * themselves to the tenant, once. Files keep their paths (a taken one gets a `-2` suffix, a skill a new name), secrets
 * a `_2` suffix; memories become tenant-wide and personal rules are dropped. Running it again changes nothing.
 */
export async function mergePersonalIntoTenant(db: Client, files: FileStore) {
  const tenant: FileLocation = { scope: "tenant" };
  const taken = async (path: string) => {
    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    return (await files.list(tenant, dir).catch(() => [])).some((e) => e.path === path);
  };
  for (const userId of await files.personalOwners()) {
    const from: FileLocation = { scope: "personal", userId };
    for (const dir of await files.list(from, SKILLS_DIR).catch(() => [])) {
      if (dir.type !== "dir") continue;
      let name = dir.name;
      for (let n = 2; await taken(`${SKILLS_DIR}/${name}`); n++) name = `${dir.name}-${n}`;
      await files.move(from, dir.path, tenant, `${SKILLS_DIR}/${name}`);
      if (name === dir.name) continue;
      const path = `${SKILLS_DIR}/${name}/SKILL.md`;
      await files
        .read(tenant, path)
        .then(({ data }) => files.write(tenant, path, Buffer.from(formatSkill({ ...parseSkill(data.toString("utf8")), name }))))
        .catch(() => {});
    }
    for await (const f of files.walk(from)) {
      const dot = f.path.lastIndexOf(".");
      const [base, ext] = dot > f.path.lastIndexOf("/") ? [f.path.slice(0, dot), f.path.slice(dot)] : [f.path, ""];
      let path = f.path;
      for (let n = 2; await taken(path); n++) path = `${base}-${n}${ext}`;
      await files.move(from, f.path, tenant, path);
    }
  }

  const { rows } = await db.execute("SELECT owner, name FROM secrets WHERE owner <> ''");
  for (const r of rows) {
    let name = String(r.name);
    for (let n = 2; (await db.execute({ sql: "SELECT 1 FROM secrets WHERE owner = '' AND name = ?", args: [name] })).rows.length; n++) name = `${r.name}_${n}`;
    await db.execute({ sql: "UPDATE secrets SET owner = '', name = ? WHERE owner = ? AND name = ?", args: [name, String(r.owner), String(r.name)] });
  }
  await db.batch(
    [
      // MCP server names are unique across the tenant already, and a server's OAuth sign-in has the server's owner.
      "UPDATE mcp_servers SET owner = '' WHERE owner <> ''",
      "UPDATE mcp_oauth SET owner = '' WHERE owner <> ''",
      "UPDATE memories SET user_id = NULL WHERE user_id IS NOT NULL",
      "UPDATE assistant_profiles SET guards = '' WHERE owner NOT IN ('', '@public') AND guards <> ''",
    ],
    "write",
  );
}
