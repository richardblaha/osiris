import { existsSync } from "node:fs";
import { mkdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Client } from "@libsql/client";
import * as tar from "tar";

/**
 * The tenant's volume: `db/tenant.db` (libSQL) and `files/`. A snapshot is a tar.gz of a consistent copy of the
 * database (`VACUUM INTO`) and the files as they are; a runtime starting on an empty volume restores the newest one.
 */
export const dbPath = (dataDir: string) => join(dataDir, "db", "tenant.db");
export const filesDir = (dataDir: string) => join(dataDir, "files");

/** Builds a snapshot and hands its stream to `consume` (an upload); the staging copy is removed afterwards. */
export async function withSnapshot<T>(db: Client, dataDir: string, consume: (archive: Readable) => Promise<T>): Promise<T> {
  const staging = join(dataDir, ".snapshot");
  await rm(staging, { recursive: true, force: true });
  await mkdir(join(staging, "db"), { recursive: true });
  await mkdir(filesDir(dataDir), { recursive: true });
  try {
    const copy = join(staging, "db", "tenant.db");
    await db.execute(`VACUUM INTO '${copy.replace(/'/g, "''")}'`);
    // The files go in through a link that tar follows; the file store itself never creates links.
    await symlink(filesDir(dataDir), join(staging, "files"));
    const archive = Readable.from(tar.c({ gzip: true, cwd: staging, follow: true, portable: true }, ["db", "files"]));
    return await consume(archive);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** Unpacks a snapshot onto an empty volume: only `db/` and `files/`, only regular files and folders. */
export async function restoreSnapshot(dataDir: string, archive: Readable): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  await pipeline(
    archive,
    tar.x({
      cwd: dataDir,
      strict: true,
      preserveOwner: false,
      filter: (path, entry) => {
        const type = (entry as { type?: string }).type;
        const allowed = /^(\.\/)?(db|files)(\/|$)/.test(path);
        return allowed && (type === "File" || type === "Directory" || type === "OldFile");
      },
    }) as unknown as NodeJS.WritableStream,
  );
}

export const hasDatabase = (dataDir: string) => existsSync(dbPath(dataDir));
