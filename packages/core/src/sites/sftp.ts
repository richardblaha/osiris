import { createHash } from "node:crypto";
import { posix } from "node:path";
import type { Client } from "@libsql/client";
import type { PublishResult, SiteTarget } from "@osiris/shared";
import SftpClient from "ssh2-sftp-client";
import type { FileLocation, FileStore } from "../files/store.ts";
import type { SecretBox } from "../secrets.ts";
import { LocalizedError } from "@osiris/platform/i18n.ts";

/** What Osiris published to a target, so it changes only its own files there. Kept next to the site. */
export const MANIFEST = ".osiris-manifest.json";
/** Published files are readable by the web server, writable only by their owner. */
const FILE_MODE = { writeStreamOptions: { mode: 0o644 } };

export interface SiteTargetInput {
  host: string;
  port: number;
  username: string;
  remoteDir: string;
  auth: "password" | "key";
  /** The password or the private key (PEM); undefined keeps the stored one. */
  secret?: string;
}

/** The server's host key changed since it was pinned: possibly someone in between. */
export class HostKeyMismatchError extends LocalizedError {}

const fingerprint = (key: Buffer) => `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;

/** Where the tenant's site is published over SFTP; secrets are sealed with the tenant's key and never returned. */
export class SiteTargetStore {
  constructor(
    private readonly db: Client,
    private readonly box: SecretBox,
  ) {}

  async list(): Promise<SiteTarget[]> {
    const { rows } = await this.db.execute("SELECT * FROM site_targets ORDER BY name");
    return rows.map((r) => ({
      name: String(r.name),
      host: String(r.host),
      port: Number(r.port),
      username: String(r.username),
      remoteDir: String(r.remote_dir),
      auth: r.auth === "key" ? "key" : "password",
      hostKey: r.host_key ? String(r.host_key) : null,
      lastPublish: r.last_publish ? (JSON.parse(String(r.last_publish)) as PublishResult) : null,
    }));
  }

  async get(name: string): Promise<(SiteTarget & { secret: string }) | undefined> {
    const target = (await this.list()).find((t) => t.name === name);
    if (!target) return undefined;
    const { rows } = await this.db.execute({ sql: "SELECT secret_enc FROM site_targets WHERE name = ?", args: [name] });
    return { ...target, secret: this.box.open(String(rows[0]!.secret_enc)) };
  }

  async put(name: string, t: SiteTargetInput) {
    const existing = await this.get(name);
    const secret = t.secret ?? existing?.secret;
    if (!secret) throw new LocalizedError("errors.sftp.credentials");
    // A different server or user means a different host key.
    const sameServer = existing && existing.host === t.host && existing.port === t.port;
    await this.db.execute({
      sql: `INSERT INTO site_targets (name, host, port, username, remote_dir, auth, secret_enc, host_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (name) DO UPDATE SET host = excluded.host, port = excluded.port, username = excluded.username,
              remote_dir = excluded.remote_dir, auth = excluded.auth, secret_enc = excluded.secret_enc, host_key = excluded.host_key,
              updated_at = datetime('now')`,
      args: [name, t.host, t.port, t.username, t.remoteDir, t.auth, this.box.seal(secret), sameServer ? existing.hostKey : null],
    });
  }

  async delete(name: string): Promise<boolean> {
    return (await this.db.execute({ sql: "DELETE FROM site_targets WHERE name = ?", args: [name] })).rowsAffected > 0;
  }

  async pinHostKey(name: string, key: string) {
    await this.db.execute({ sql: "UPDATE site_targets SET host_key = ? WHERE name = ? AND host_key IS NULL", args: [key, name] });
  }

  async recordPublish(name: string, result: PublishResult) {
    await this.db.execute({ sql: "UPDATE site_targets SET last_publish = ? WHERE name = ?", args: [JSON.stringify(result), name] });
  }
}

/** Opens an SFTP session; the first connection pins the server's host key, later ones must match it. */
async function connect(store: SiteTargetStore, target: SiteTarget & { secret: string }, sftp = new SftpClient()) {
  let seen: string | undefined;
  await sftp.connect({
    host: target.host,
    port: target.port,
    username: target.username,
    ...(target.auth === "key" ? { privateKey: target.secret } : { password: target.secret }),
    readyTimeout: 15_000,
    hostVerifier: (key: Buffer) => {
      seen = fingerprint(key);
      return !target.hostKey || target.hostKey === seen;
    },
  }).catch((err: Error) => {
    if (target.hostKey && seen && seen !== target.hostKey) {
      throw new HostKeyMismatchError("errors.sftp.hostKey", { host: target.host, seen, expected: target.hostKey });
    }
    throw err;
  });
  if (!target.hostKey && seen) await store.pinHostKey(target.name, seen);
  return sftp;
}

/** Connects and lists the target folder, to check a target's settings. */
export async function testTarget(store: SiteTargetStore, name: string): Promise<string[]> {
  const target = await store.get(name);
  if (!target) throw new LocalizedError("errors.sftp.targetNotFound", { name });
  const sftp = await connect(store, target);
  try {
    if (!(await sftp.exists(target.remoteDir))) return [];
    return (await sftp.list(target.remoteDir)).map((e) => e.name).sort();
  } finally {
    await sftp.end().catch(() => {});
  }
}

/**
 * Publishes a folder of the tenant's files to a target: uploads files that are new or changed since the last publish
 * (by content hash, from the manifest kept on the server) and deletes those Osiris published before but that are gone
 * now. Files on the server that Osiris didn't put there are left alone.
 */
export async function publishFolder(
  files: FileStore,
  loc: FileLocation,
  dir: string,
  store: SiteTargetStore,
  name: string,
  sftp?: SftpClient,
): Promise<PublishResult> {
  const target = await store.get(name);
  if (!target) throw new LocalizedError("errors.sftp.targetNotFound", { name });
  const local = new Map<string, { path: string; hash: string; size: number }>();
  for await (const entry of files.walk(loc, dir)) {
    const rel = dir ? entry.path.slice(dir.length + 1) : entry.path;
    if (rel === MANIFEST) continue;
    const { data } = await files.read(loc, entry.path);
    local.set(rel, { path: entry.path, hash: createHash("sha256").update(data).digest("hex"), size: data.length });
  }
  if (!local.has("index.html")) throw new LocalizedError("errors.sftp.noIndex", { path: dir || "/" });

  const at = new Date().toISOString();
  let client: SftpClient | undefined;
  try {
    client = await connect(store, target, sftp);
    const remote = (rel: string) => posix.join(target.remoteDir, rel);
    await client.mkdir(target.remoteDir, true);
    const before: Record<string, string> = await client
      .get(remote(MANIFEST))
      .then((b) => JSON.parse((b as Buffer).toString("utf8")) as Record<string, string>)
      .catch(() => ({}));
    let uploaded = 0;
    let bytes = 0;
    const dirs = new Set<string>();
    for (const [rel, f] of local) {
      if (before[rel] === f.hash) continue;
      const parent = posix.dirname(remote(rel));
      if (!dirs.has(parent)) {
        await client.mkdir(parent, true);
        dirs.add(parent);
      }
      await client.put((await files.read(loc, f.path)).data, remote(rel), FILE_MODE);
      uploaded++;
      bytes += f.size;
    }
    let deleted = 0;
    for (const rel of Object.keys(before)) {
      if (local.has(rel)) continue;
      await client.delete(remote(rel), true);
      deleted++;
    }
    await client.put(Buffer.from(JSON.stringify(Object.fromEntries([...local].map(([rel, f]) => [rel, f.hash])), null, 1)), remote(MANIFEST), FILE_MODE);
    const result: PublishResult = { at, ok: true, uploaded, deleted, unchanged: local.size - uploaded, bytes };
    await store.recordPublish(name, result);
    return result;
  } catch (err) {
    await store.recordPublish(name, { at, ok: false, uploaded: 0, deleted: 0, unchanged: 0, bytes: 0, error: (err as Error).message });
    throw err;
  } finally {
    await client?.end().catch(() => {});
  }
}
