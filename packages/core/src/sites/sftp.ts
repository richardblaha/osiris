import { createHash } from "node:crypto";
import { egressProxy, tunnel } from "../net/egress.ts";
import { posix } from "node:path";
import type { Records } from "../projects/records.ts";
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

/** A target as kept in `site/targets/<name>.json` (goes to git); its password or key is in `private/site-targets/`. */
type StoredTarget = Omit<SiteTarget, "name">;
const targetFile = (name: string) => `site/targets/${name}.json`;
const secretFile = (name: string) => `private/site-targets/${name}.json`;

/** Where the project's site is published over SFTP; secrets are sealed with the project's key and never returned. */
export class SiteTargetStore {
  constructor(
    private readonly records: Records,
    private readonly box: SecretBox,
  ) {}

  async list(): Promise<SiteTarget[]> {
    return (await this.records.all<StoredTarget>("site/targets")).map((r) => ({ ...r.value, name: r.name }));
  }

  async get(name: string): Promise<(SiteTarget & { secret: string }) | undefined> {
    const target = (await this.list()).find((t) => t.name === name);
    const sealed = target && (await this.records.read<{ secretEnc: string }>(secretFile(name)));
    return target && sealed ? { ...target, secret: this.box.open(sealed.secretEnc) } : undefined;
  }

  async put(name: string, t: SiteTargetInput) {
    const existing = await this.get(name);
    const secret = t.secret ?? existing?.secret;
    if (!secret) throw new LocalizedError("errors.sftp.credentials");
    // A different server or user means a different host key.
    const sameServer = existing && existing.host === t.host && existing.port === t.port;
    await this.records.write(secretFile(name), { secretEnc: this.box.seal(secret) });
    await this.records.write(targetFile(name), {
      host: t.host,
      port: t.port,
      username: t.username,
      remoteDir: t.remoteDir,
      auth: t.auth,
      hostKey: sameServer ? existing.hostKey : null,
      lastPublish: existing?.lastPublish ?? null,
    } satisfies StoredTarget);
  }

  async delete(name: string): Promise<boolean> {
    await this.records.remove(secretFile(name));
    return this.records.remove(targetFile(name));
  }

  async pinHostKey(name: string, key: string) {
    await this.records.update<StoredTarget>(targetFile(name), (t) => (t!.hostKey ? t! : { ...t!, hostKey: key }));
  }

  async recordPublish(name: string, result: PublishResult) {
    await this.records.update<StoredTarget>(targetFile(name), (t) => ({ ...t!, lastPublish: result }));
  }
}

/** Opens an SFTP session; the first connection pins the server's host key, later ones must match it. */
async function connect(store: SiteTargetStore, target: SiteTarget & { secret: string }, sftp = new SftpClient()) {
  let seen: string | undefined;
  await sftp.connect({
    host: target.host,
    port: target.port,
    // Behind the egress gate, SSH runs over its tunnel.
    ...(egressProxy() ? { sock: await tunnel(target.host, target.port) } : {}),
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
 * Publishes a folder of the project's files to a target: uploads files that are new or changed since the last publish
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
