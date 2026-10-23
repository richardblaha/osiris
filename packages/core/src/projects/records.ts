import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** A folder name for an id that may hold `/` or `..` (a user's sub, a thread id). */
export const idName = (id: string) => Buffer.from(id).toString("base64url");
export const fromIdName = (name: string) => Buffer.from(name, "base64url").toString();

/** A user's private folder (their settings, keys, accounts, own copies). */
export const userDir = (userId: string) => `private/users/${idName(userId)}`;

/** Users who have a private folder. */
export const userIds = async (records: Records) => (await records.list("private/users")).map(fromIdName);

const isMissing = (err: unknown) => (err as NodeJS.ErrnoException)?.code === "ENOENT";

/** Checked segments of a record path: no empty, hidden or `..` parts, no backslashes or control characters. */
function segments(path: string): string[] {
  const parts = path.split("/");
  for (const s of parts) {
    if (!s || s.startsWith(".") || s.length > 200 || /[\\\x00-\x1f\x7f]/.test(s)) throw new Error(`Invalid record path ${JSON.stringify(path)}`);
  }
  return parts;
}

/**
 * The project's own data under `.osiris/`: JSON and text records at relative paths. A write goes to a temp file that is
 * renamed into place, so a reader never sees half a record. `lock` serializes read-modify-write per key.
 */
export class Records {
  // ponytail: in-process locks; a project has exactly one runtime. A lock file if that ever changes.
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(readonly dir: string) {}

  path(path: string): string {
    return join(this.dir, ...segments(path));
  }

  async readText(path: string): Promise<string | undefined> {
    return readFile(this.path(path), "utf8").catch((err) => (isMissing(err) ? undefined : Promise.reject(err)));
  }

  async read<T>(path: string): Promise<T | undefined> {
    const text = await this.readText(path);
    return text === undefined ? undefined : (JSON.parse(text) as T);
  }

  async writeText(path: string, text: string | Uint8Array): Promise<void> {
    const abs = this.path(path);
    await mkdir(dirname(abs), { recursive: true, mode: 0o750 });
    const tmp = join(dirname(abs), `.${randomUUID()}.tmp`);
    await writeFile(tmp, text, { mode: 0o640 });
    await rename(tmp, abs);
  }

  async write(path: string, value: unknown): Promise<void> {
    await this.writeText(path, `${JSON.stringify(value, null, 2)}\n`);
  }

  /** Removes a record or a folder of them; true when something was there. */
  async remove(path: string): Promise<boolean> {
    const abs = this.path(path);
    const existed = await lstat(abs).then(() => true, () => false);
    await rm(abs, { recursive: true, force: true });
    return existed;
  }

  /** Names in a folder (records and subfolders), without in-progress writes; [] when there is no folder. */
  async list(dir: string): Promise<string[]> {
    const names = await readdir(dir ? this.path(dir) : this.dir).catch((err) => (isMissing(err) || (err as NodeJS.ErrnoException).code === "ENOTDIR" ? [] : Promise.reject(err)));
    return names.filter((n) => !n.startsWith(".")).sort();
  }

  /** When a record was last written, or undefined when there is none. */
  async modified(path: string): Promise<Date | undefined> {
    return lstat(this.path(path)).then((s) => s.mtime, () => undefined);
  }

  /** Paths of every file under a folder (relative to it), depth first, sorted. */
  async walk(dir: string): Promise<string[]> {
    const out: string[] = [];
    for (const name of await this.list(dir)) {
      const path = dir ? `${dir}/${name}` : name;
      const s = await lstat(this.path(path)).catch(() => undefined);
      if (s?.isDirectory()) out.push(...(await this.walk(path)).map((p) => `${name}/${p}`));
      else if (s?.isFile()) out.push(name);
    }
    return out;
  }

  /** Every JSON record in a folder, by name without `.json`. */
  async all<T>(dir: string): Promise<{ name: string; value: T }[]> {
    const out: { name: string; value: T }[] = [];
    for (const n of await this.list(dir)) {
      if (!n.endsWith(".json")) continue;
      const value = await this.read<T>(`${dir}/${n}`);
      if (value !== undefined) out.push({ name: n.slice(0, -5), value });
    }
    return out;
  }

  /** Runs `fn` after every earlier `lock` call with the same key has finished. */
  lock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.locks.get(key) ?? Promise.resolve()).then(fn, fn);
    const tail = run.catch(() => undefined);
    this.locks.set(key, tail);
    void tail.then(() => this.locks.get(key) === tail && this.locks.delete(key));
    return run;
  }

  /** Reads a JSON record, changes it and writes it back, under the record's lock. */
  update<T>(path: string, change: (current: T | undefined) => T | Promise<T>): Promise<T> {
    return this.lock(path, async () => {
      const next = await change(await this.read<T>(path));
      await this.write(path, next);
      return next;
    });
  }
}

/** Splits `---` frontmatter (`key: value` lines) from the body; no frontmatter means all body. */
export function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]!] = kv[2]!.trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return { meta, body: match[2]!.replace(/^\r?\n/, "") };
}

/** Frontmatter with the given values (empty ones left out), then the body. */
export function formatFrontmatter(meta: Record<string, string | number | undefined | null>, body: string): string {
  const lines = Object.entries(meta)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}: ${String(v).replace(/\s+/g, " ").trim()}`);
  return lines.length ? `---\n${lines.join("\n")}\n---\n\n${body}` : body;
}
