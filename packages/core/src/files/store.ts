import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { FileEntry, FileScope } from "@osiris/shared";
import { contentMatches, extensionOf, fileType } from "@osiris/shared";
import { LocalizedError, type Params } from "@osiris/platform/i18n.ts";

/** Where a file lives: the project's shared files, a user's own files, or one thread's temporary files. */
export type FileLocation = { scope: "project" } | { scope: "personal"; userId: string } | { scope: "temp"; threadId: string };

/** A change the store made: a file written (or a folder moved in), or a file or folder removed (or moved away). */
export type FileChange = { kind: "write" | "delete"; loc: FileLocation; path: string };

export type FileErrorCode = "invalid" | "not_found" | "exists" | "too_large" | "quota" | "type";

/** A refused file operation; its message is safe to show to the user and the model. */
export class FileError extends LocalizedError {
  constructor(
    readonly code: FileErrorCode,
    key: string,
    params?: Params,
  ) {
    super(key, params);
  }
}

export interface FileStoreOptions {
  /** Largest single file. */
  maxFileBytes?: number;
  /** All of the project's files together: the volume's ceiling. */
  quotaBytes?: number;
  /** The project's own, lower limit when one is set (a system admin's quota), read on every write. */
  quota?: () => Promise<number | null>;
  /** Told about every change once it's on disk (indexes follow the files); its failure doesn't undo the change. */
  onChange?: (change: FileChange) => Promise<void>;
}

const MAX_PATH = 512;
const MAX_DEPTH = 16;
const MAX_SEGMENT = 120;

/** The one hidden name the files reach: the project website's VitePress config and theme (`.osiris` and `.git` never). */
export const VITEPRESS_DIR = ".vitepress";
const visible = (name: string) => !name.startsWith(".") || name === VITEPRESS_DIR;

/** Splits a relative path into checked segments: no `..`, hidden names (but `.vitepress`), control characters or backslashes. */
export function pathSegments(path: string, { allowRoot = false } = {}): string[] {
  const p = path.normalize("NFC").replace(/^\/+|\/+$/g, "");
  if (!p) {
    if (allowRoot) return [];
    throw new FileError("invalid", "errors.files.pathMissing");
  }
  if (p.length > MAX_PATH) throw new FileError("invalid", "errors.files.pathTooLong");
  const segments = p.split("/");
  if (segments.length > MAX_DEPTH) throw new FileError("invalid", "errors.files.tooDeep");
  for (const s of segments) {
    if (!s || s === "." || s === ".." || !visible(s) || s.length > MAX_SEGMENT || s !== s.trim() || /[\\\x00-\x1f\x7f]/.test(s)) {
      throw new FileError("invalid", "errors.files.badName", { name: s });
    }
  }
  return segments;
}

/** Directory names derived from ids (user sub, thread id) can't contain `/` or `..`. */
const idDir = (id: string) => Buffer.from(id).toString("base64url");

/** Where users' own files and threads' temporary files are, inside the project's `.osiris/`. */
const USERS = ".osiris/private/users";
const TMP = ".osiris/tmp";

const isMissing = (err: unknown) => (err as NodeJS.ErrnoException)?.code === "ENOENT";

/**
 * A project's files on local disk (in production the project's own volume): the project folder itself, a user's own
 * files in `.osiris/private/users/<sub>/files` and a thread's in `.osiris/tmp/<thread>`. Hidden names (`.osiris`, `.git`)
 * are never listed or reached, so neither the agent nor the API touches the project's own data. Paths are relative to a scope root and
 * validated segment by segment; the store never creates symlinks and refuses to traverse any it finds. Writes go to a
 * temp file that is renamed into place, so a reader never sees half a file. Only known file types are accepted, and
 * their content must match the extension.
 */
export class FileStore {
  private readonly maxFileBytes: number;
  private readonly quotaBytes: number;
  private readonly quota?: () => Promise<number | null>;
  private readonly onChange?: (change: FileChange) => Promise<void>;
  private used?: Promise<number>;

  constructor(
    private readonly root: string,
    options: FileStoreOptions = {},
  ) {
    this.maxFileBytes = options.maxFileBytes ?? 25 * 1024 * 1024;
    this.quotaBytes = options.quotaBytes ?? 1024 * 1024 * 1024;
    this.quota = options.quota;
    this.onChange = options.onChange;
  }

  get limits() {
    return { maxFileBytes: this.maxFileBytes, quotaBytes: this.quotaBytes };
  }

  /** The limit in force: the project's quota, never above the volume's ceiling. */
  async quotaInForce(): Promise<number> {
    const own = await this.quota?.();
    return own == null ? this.quotaBytes : Math.min(own, this.quotaBytes);
  }

  async list(loc: FileLocation, dir = ""): Promise<FileEntry[]> {
    const segments = pathSegments(dir, { allowRoot: true });
    const abs = await this.resolve(loc, segments);
    let names;
    try {
      names = await readdir(abs, { withFileTypes: true });
    } catch (err) {
      if (isMissing(err)) {
        if (segments.length) throw new FileError("not_found", "errors.files.folderMissing");
        return [];
      }
      if ((err as NodeJS.ErrnoException).code === "ENOTDIR") throw new FileError("invalid", "errors.files.notFolder");
      throw err;
    }
    const entries: FileEntry[] = [];
    for (const d of names) {
      // Hidden names are in-progress writes or the project's own data; symlinks are never created by the store and never followed.
      if (!visible(d.name) || !(d.isFile() || d.isDirectory())) continue;
      const s = await lstat(join(abs, d.name)).catch(() => undefined);
      if (!s) continue;
      entries.push(this.entry(loc, [...segments, d.name].join("/"), d.isDirectory(), s.size, s.mtime));
    }
    return entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, "cs") : a.type === "dir" ? -1 : 1));
  }

  async read(loc: FileLocation, path: string): Promise<{ entry: FileEntry; data: Buffer }> {
    const segments = pathSegments(path);
    const abs = await this.resolve(loc, segments);
    const handle = await open(abs, constants.O_RDONLY | constants.O_NOFOLLOW).catch((err) => {
      if (isMissing(err)) throw new FileError("not_found", "errors.files.fileMissing", { path });
      if ((err as NodeJS.ErrnoException).code === "ELOOP") throw new FileError("invalid", "errors.files.invalid");
      throw err;
    });
    try {
      const s = await handle.stat();
      if (!s.isFile()) throw new FileError("invalid", "errors.files.isFolder", { path });
      const data = await handle.readFile();
      return { entry: this.entry(loc, segments.join("/"), false, s.size, s.mtime), data };
    } finally {
      await handle.close();
    }
  }

  async write(loc: FileLocation, path: string, data: Uint8Array, { overwrite = true } = {}): Promise<FileEntry> {
    const segments = pathSegments(path);
    const type = fileType(path);
    if (!type) throw new FileError("type", "errors.files.typeNotAllowed", { extension: extensionOf(path) || "?" });
    if (data.length > this.maxFileBytes) {
      throw new FileError("too_large", "errors.files.tooLarge", { mb: Math.round(this.maxFileBytes / 1024 / 1024) });
    }
    if (!contentMatches(path, data)) throw new FileError("type", "errors.files.contentMismatch", { extension: extensionOf(path) });

    const abs = await this.resolve(loc, segments);
    const existing = await lstat(abs).catch((err) => (isMissing(err) ? undefined : Promise.reject(err)));
    if (existing?.isDirectory()) throw new FileError("exists", "errors.files.folderExists", { path });
    if (existing && !overwrite) throw new FileError("exists", "errors.files.fileExists", { path });
    const used = await this.usage();
    if (used - (existing?.size ?? 0) + data.length > (await this.quotaInForce())) {
      throw new FileError("quota", "errors.files.quota");
    }

    await this.mkdirs(loc, segments.slice(0, -1));
    const tmp = join(dirname(abs), `.${randomUUID()}.tmp`);
    const handle = await open(tmp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o640);
    try {
      await handle.writeFile(data);
      await handle.sync();
    } catch (err) {
      await handle.close();
      await rm(tmp, { force: true });
      throw err;
    }
    await handle.close();
    await rename(tmp, abs);
    this.adjustUsage(data.length - (existing?.size ?? 0));
    await this.changed({ kind: "write", loc, path: segments.join("/") });
    return this.entry(loc, segments.join("/"), false, data.length, new Date());
  }

  async mkdir(loc: FileLocation, path: string): Promise<FileEntry> {
    const segments = pathSegments(path);
    await this.mkdirs(loc, segments);
    return this.entry(loc, segments.join("/"), true, 0, new Date());
  }

  /** Deletes a file, or a folder with everything in it. */
  async delete(loc: FileLocation, path: string): Promise<void> {
    const segments = pathSegments(path);
    const abs = await this.resolve(loc, segments);
    const s = await lstat(abs).catch((err) => {
      if (isMissing(err)) throw new FileError("not_found", "errors.files.missing", { path });
      throw err;
    });
    const size = s.isDirectory() ? await sizeOf(abs) : s.isFile() ? s.size : 0;
    await rm(abs, { recursive: true, force: true });
    this.adjustUsage(-size);
    await this.changed({ kind: "delete", loc, path: segments.join("/") });
  }

  /** Moves or renames a file or folder, also between scopes. Never overwrites. */
  async move(from: FileLocation, fromPath: string, to: FileLocation, toPath: string): Promise<FileEntry> {
    const src = pathSegments(fromPath);
    const dst = pathSegments(toPath);
    const srcAbs = await this.resolve(from, src);
    const dstAbs = await this.resolve(to, dst);
    const s = await lstat(srcAbs).catch((err) => {
      if (isMissing(err)) throw new FileError("not_found", "errors.files.missing", { path: fromPath });
      throw err;
    });
    if (s.isSymbolicLink()) throw new FileError("invalid", "errors.files.invalid");
    if (await lstat(dstAbs).then(() => true, () => false)) throw new FileError("exists", "errors.files.exists", { path: toPath });
    if (s.isFile() && extensionOf(fromPath) !== extensionOf(toPath)) {
      // A new extension must still match the content.
      const { data } = await this.read(from, fromPath);
      if (!fileType(toPath) || !contentMatches(toPath, data)) throw new FileError("type", "errors.files.renameMismatch");
    }
    if (s.isDirectory() && dstAbs.startsWith(`${srcAbs}/`)) throw new FileError("invalid", "errors.files.moveIntoItself");
    await this.mkdirs(to, dst.slice(0, -1));
    await rename(srcAbs, dstAbs);
    await this.changed({ kind: "delete", loc: from, path: src.join("/") });
    await this.changed({ kind: "write", loc: to, path: dst.join("/") });
    return this.entry(to, dst.join("/"), s.isDirectory(), s.isFile() ? s.size : 0, new Date());
  }

  /** Every file under `dir` (a file path yields that file), depth first; hidden and in-progress files are skipped. */
  async *walk(loc: FileLocation, dir = ""): AsyncGenerator<FileEntry> {
    const abs = await this.resolve(loc, pathSegments(dir, { allowRoot: true }));
    const s = await lstat(abs).catch(() => undefined);
    if (s?.isFile()) {
      yield this.entry(loc, dir, false, s.size, s.mtime);
      return;
    }
    if (!s?.isDirectory()) return;
    for (const e of await this.list(loc, dir)) {
      if (e.type === "dir") yield* this.walk(loc, e.path);
      else yield e;
    }
  }

  /** Users who have personal files. */
  async personalOwners(): Promise<string[]> {
    const dirs = await readdir(join(this.root, USERS), { withFileTypes: true }).catch(() => []);
    const owners: string[] = [];
    for (const d of dirs) if (d.isDirectory() && (await lstat(join(this.root, USERS, d.name, "files")).catch(() => undefined))?.isDirectory()) owners.push(Buffer.from(d.name, "base64url").toString());
    return owners;
  }

  private async changed(change: FileChange) {
    if (change.loc.scope === "temp" || !this.onChange) return;
    await this.onChange(change).catch((err) => console.error(`Indexing ${change.path} failed`, err));
  }

  /** Absolute path of an existing folder (for packing a site); the same checks as every other access. */
  async folderPath(loc: FileLocation, path: string): Promise<string> {
    const abs = await this.resolve(loc, pathSegments(path, { allowRoot: true }));
    const s = await lstat(abs).catch(() => undefined);
    if (!s?.isDirectory()) throw new FileError("not_found", "errors.files.folderNotFound", { path: path || "/" });
    return abs;
  }

  /** Removes a thread's temporary files (when the thread is deleted). */
  async removeTemp(threadId: string): Promise<void> {
    const dir = join(this.root, TMP, idDir(threadId));
    const size = await sizeOf(dir);
    await rm(dir, { recursive: true, force: true });
    this.adjustUsage(-size);
  }

  /** The threads that have temporary files (a thread's scratchpad lives as long as the thread). */
  async tempThreads(): Promise<string[]> {
    const dirs = await readdir(join(this.root, TMP), { withFileTypes: true }).catch(() => []);
    return dirs.filter((d) => d.isDirectory()).map((d) => Buffer.from(d.name, "base64url").toString());
  }

  /** Bytes used by the project's files. Counted once, then kept up to date by the store's own writes. */
  usage(): Promise<number> {
    return (this.used ??= this.count().catch((err) => {
      this.used = undefined;
      throw err;
    }));
  }

  /** The project's files, users' own and threads' temporary ones; not the project's data in `.osiris/` or `.git`. */
  private async count(): Promise<number> {
    let total = 0;
    for (const name of await readdir(this.root).catch(() => [])) if (visible(name)) total += await sizeOf(join(this.root, name));
    for (const user of await readdir(join(this.root, USERS)).catch(() => [])) total += await sizeOf(join(this.root, USERS, user, "files"));
    return total + (await sizeOf(join(this.root, TMP)));
  }

  private adjustUsage(delta: number) {
    if (this.used) this.used = this.used.then((n) => Math.max(0, n + delta));
  }

  private scopeDir(loc: FileLocation): string {
    switch (loc.scope) {
      case "project":
        return this.root;
      case "personal":
        return join(this.root, USERS, idDir(loc.userId), "files");
      case "temp":
        return join(this.root, TMP, idDir(loc.threadId));
    }
  }

  /** Absolute path for the segments, refusing any symlink among the parts that already exist. */
  private async resolve(loc: FileLocation, segments: string[]): Promise<string> {
    let path = this.scopeDir(loc);
    for (let i = 0; i <= segments.length; i++) {
      if (i > 0) path = join(path, segments[i - 1]!);
      const s = await lstat(path).catch((err) => (isMissing(err) ? undefined : Promise.reject(err)));
      if (!s) return join(path, ...segments.slice(i));
      if (s.isSymbolicLink()) throw new FileError("invalid", "errors.files.badPath");
    }
    return path;
  }

  private async mkdirs(loc: FileLocation, segments: string[]) {
    const abs = await this.resolve(loc, segments);
    const s = await lstat(abs).catch(() => undefined);
    if (s && !s.isDirectory()) throw new FileError("exists", "errors.files.isFile", { path: segments.join("/") });
    await mkdir(abs, { recursive: true, mode: 0o750 });
  }

  private entry(loc: FileLocation, path: string, dir: boolean, size: number, modified: Date): FileEntry {
    const scope: FileScope = loc.scope;
    return {
      scope,
      path,
      name: path.slice(path.lastIndexOf("/") + 1),
      type: dir ? "dir" : "file",
      size: dir ? 0 : size,
      mime: dir ? null : (fileType(path)?.mime ?? null),
      modifiedAt: modified.toISOString(),
    };
  }
}

async function sizeOf(path: string): Promise<number> {
  const s = await lstat(path).catch(() => undefined);
  if (!s) return 0;
  if (s.isFile()) return s.size;
  if (!s.isDirectory()) return 0;
  let total = 0;
  for (const name of await readdir(path)) total += await sizeOf(join(path, name));
  return total;
}
