import { existsSync } from "node:fs";
import { mkdir, rename, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Client } from "@libsql/client";
import * as tar from "tar";

/**
 * The project's volume: the project folder `project/` (its files and `.osiris/`). A snapshot is a tar.gz of the folder
 * as it is, without the rebuildable cache, plus a consistent copy (`VACUUM INTO`) of the project's own database
 * `.osiris/data.db`; a runtime starting on an empty volume restores the newest one.
 */
export const projectDir = (dataDir: string) => join(dataDir, "project");
const DATA_DB = ".osiris/data.db";
/** Left out: the cache is rebuilt from the files, and the live database goes in as its consistent copy. */
const skipped = (path: string) => /^project\/\.osiris\/(cache(\/|$)|data\.db)/.test(path);

/** Builds a snapshot and hands its stream to `consume` (an upload); the staging copy is removed afterwards. */
export async function withSnapshot<T>(dataDir: string, data: Client | undefined, consume: (archive: Readable) => Promise<T>): Promise<T> {
  const staging = join(dataDir, ".snapshot");
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  await mkdir(projectDir(dataDir), { recursive: true });
  try {
    const entries = ["project"];
    if (data) {
      await data.execute(`VACUUM INTO '${join(staging, "data.db").replace(/'/g, "''")}'`);
      entries.push("data.db");
    }
    // The folder goes in through a link that tar follows; nothing in the project creates links.
    await symlink(projectDir(dataDir), join(staging, "project"));
    const archive = Readable.from(tar.c({ gzip: true, cwd: staging, follow: true, portable: true, filter: (path) => !skipped(path.replace(/^\.\//, "")) }, entries));
    return await consume(archive);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** Unpacks a snapshot onto an empty volume: only `project/` and `data.db`, only regular files and folders. */
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
        const allowed = /^(\.\/)?(project(\/|$)|data\.db$)/.test(path);
        return allowed && (type === "File" || type === "Directory" || type === "OldFile");
      },
    }) as unknown as NodeJS.WritableStream,
  );
  if (existsSync(join(dataDir, "data.db"))) {
    await mkdir(join(projectDir(dataDir), ".osiris"), { recursive: true });
    await rename(join(dataDir, "data.db"), join(projectDir(dataDir), DATA_DB));
  }
}

/** Whether the volume holds a project already (else a snapshot or a clone fills it). */
export const hasProject = (dataDir: string) => existsSync(join(projectDir(dataDir), ".osiris"));
