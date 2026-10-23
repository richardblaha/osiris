import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as tar from "tar";
import { fileType, type SiteRelease } from "@osiris/shared";
import type { ObjectStore } from "@osiris/platform/objects.ts";
import { run, type Db } from "@osiris/platform/rqlite.ts";
import { LocalizedError } from "@osiris/platform/i18n.ts";

export const SITE_LIMITS = { files: 2000, fileBytes: 25 * 1024 * 1024, totalBytes: 200 * 1024 * 1024, uploadBytes: 220 * 1024 * 1024 };
/** Releases kept per domain, for rollback. */
const KEEP_RELEASES = 5;

export class PublishError extends LocalizedError {}

/** A path inside a site: no `..`, no hidden files except `.well-known`, only types we serve. */
function sitePath(raw: string): string | null {
  const parts = raw.replace(/^\.\//, "").split("/").filter(Boolean);
  if (!parts.length) return null;
  for (const [i, p] of parts.entries()) {
    if (p === "." || p === ".." || /[\\\x00-\x1f\x7f]/.test(p) || p.length > 120) return null;
    if (p.startsWith(".") && !(i === 0 && p === ".well-known")) return null;
  }
  return parts.join("/");
}

export const siteKey = (project: string, release: string, path = "") => `sites/${project}/${release}${path ? `/${path}` : ""}`;

/**
 * Publishes project sites: the runtime sends a folder as tar.gz, control checks every entry (regular files only, known
 * types, size and count limits), uploads it as a new release to object storage and switches the domain to it in one
 * write. Runtimes never get object storage credentials.
 */
export class SitePublisher {
  constructor(
    private readonly db: Db,
    private readonly objects: ObjectStore,
  ) {}

  async publish(projectId: string, domain: string, archive: Readable, createdBy: string | null, now = Date.now()): Promise<SiteRelease> {
    const [d] = await this.db.query<{ status: string }>("SELECT status FROM domains WHERE project_id = ? AND domain = ?", [projectId, domain], { fresh: true });
    if (!d) throw new PublishError("errors.publish.foreignDomain");
    if (d.status !== "verified") throw new PublishError("errors.publish.unverified");

    const work = await mkdtemp(join(tmpdir(), "osiris-site-"));
    try {
      const upload = join(work, "site.tar.gz");
      await pipeline(archive, createWriteStream(upload));
      const root = join(work, "site");
      const files = await this.extract(upload, root);
      if (!files.some((f) => f.path === "index.html")) throw new PublishError("errors.publish.noIndex");

      const release = `${new Date(now).toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomBytes(4).toString("hex")}`;
      let bytes = 0;
      for (const f of files) {
        const data = await readFile(join(root, ...f.path.split("/")));
        bytes += data.length;
        await this.objects.put(siteKey(projectId, release, f.path), data, fileType(f.path)!.mime);
      }
      await this.db.execute([
        run(
          "INSERT INTO site_releases (id, project_id, domain, files, bytes, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          release,
          projectId,
          domain,
          files.length,
          bytes,
          createdBy,
          now,
        ),
        run("UPDATE domains SET release_id = ? WHERE project_id = ? AND domain = ?", release, projectId, domain),
      ]);
      await this.prune(projectId, domain);
      return { id: release, domain, files: files.length, bytes, createdBy, createdAt: new Date(now).toISOString(), current: true };
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }

  private async extract(archive: string, root: string): Promise<{ path: string }[]> {
    await rm(root, { recursive: true, force: true });
    await mkdir(root, { recursive: true });
    let count = 0;
    let total = 0;
    let problem: PublishError | null = null;
    await tar.x({
      file: archive,
      cwd: root,
      strict: true,
      preserveOwner: false,
      // Only regular files and folders; links and devices are refused outright.
      filter: (path, entry) => {
        const e = entry as { type?: string; size?: number };
        if (e.type === "Directory") return !!sitePath(path) || path === "./" || path === ".";
        const clean = sitePath(path);
        if (e.type !== "File" && e.type !== "OldFile" && e.type !== "ContiguousFile") problem ??= new PublishError("errors.publish.entryType", { path });
        else if (!clean) problem ??= new PublishError("errors.publish.path", { path });
        else if (!fileType(clean)) problem ??= new PublishError("errors.publish.fileType", { path: clean });
        else if ((e.size ?? 0) > SITE_LIMITS.fileBytes) problem ??= new PublishError("errors.publish.fileTooLarge", { path: clean });
        else if (++count > SITE_LIMITS.files) problem ??= new PublishError("errors.publish.tooManyFiles", { count: SITE_LIMITS.files });
        else if ((total += e.size ?? 0) > SITE_LIMITS.totalBytes) problem ??= new PublishError("errors.publish.tooLarge");
        else return true;
        return false;
      },
    });
    if (problem) throw problem;
    const out: { path: string }[] = [];
    const walk = async (dir: string) => {
      for (const d of await readdir(dir, { withFileTypes: true })) {
        const p = join(dir, d.name);
        if (d.isDirectory()) await walk(p);
        else if (d.isFile()) out.push({ path: relative(root, p).split(sep).join("/") });
      }
    };
    await walk(root);
    return out;
  }

  async releases(projectId: string, domain?: string): Promise<SiteRelease[]> {
    const rows = await this.db.query<{ id: string; domain: string; files: number; bytes: number; created_by: string | null; created_at: number; current: string | null }>(
      `SELECT r.*, d.release_id AS current FROM site_releases r LEFT JOIN domains d ON d.domain = r.domain
       WHERE r.project_id = ? ${domain ? "AND r.domain = ?" : ""} ORDER BY r.created_at DESC`,
      domain ? [projectId, domain] : [projectId],
    );
    return rows.map((r) => ({
      id: r.id,
      domain: r.domain,
      files: Number(r.files),
      bytes: Number(r.bytes),
      createdBy: r.created_by,
      createdAt: new Date(Number(r.created_at)).toISOString(),
      current: r.current === r.id,
    }));
  }

  /** Switches the domain back to an earlier release. */
  async activate(projectId: string, domain: string, release: string) {
    const [r] = await this.db.execute([
      run(
        `UPDATE domains SET release_id = ? WHERE project_id = ? AND domain = ?
           AND EXISTS (SELECT 1 FROM site_releases WHERE id = ? AND project_id = ? AND domain = ?)`,
        release,
        projectId,
        domain,
        release,
        projectId,
        domain,
      ),
    ]);
    if (!r?.rowsAffected) throw new PublishError("errors.publish.releaseNotFound");
  }

  /** Deletes releases beyond the newest few (never the current one). */
  async prune(projectId: string, domain: string, keep = KEEP_RELEASES) {
    const all = await this.releases(projectId, domain);
    const old = all.slice(keep).filter((r) => !r.current);
    await this.drop(projectId, old.map((r) => r.id));
  }

  /** Removes every release of a domain (when the domain is removed). */
  async removeDomain(projectId: string, domain: string) {
    await this.drop(projectId, (await this.releases(projectId, domain)).map((r) => r.id));
  }

  private async drop(projectId: string, releases: string[]) {
    for (const id of releases) {
      const keys = (await this.objects.list(`${siteKey(projectId, id)}/`)).map((o) => o.key);
      await this.objects.delete(keys);
      await this.db.execute([run("DELETE FROM site_releases WHERE id = ? AND project_id = ?", id, projectId)]);
    }
  }
}
