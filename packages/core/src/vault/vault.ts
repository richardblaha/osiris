import type { Client } from "@libsql/client";
import type { Scope, SecretSummary } from "@osiris/shared";
import type { SecretBox } from "../secrets.ts";
import { hostAllowed, SECRET_NAME, SECRET_REF, SecretUseError } from "./template.ts";

/** Row owner: '' for project-wide secrets, the user's sub for personal ones. */
export const secretOwner = (scope: Scope, userId: string) => (scope === "project" ? "" : userId);

/**
 * Secrets of one project and its users. Values are sealed at rest and never leave the server except when
 * substituted into a request to one of the secret's allowed hosts.
 */
export class SecretVault {
  constructor(
    private readonly db: Client,
    private readonly box: SecretBox,
  ) {}

  /** Project secrets plus `userId`'s personal ones, without values; a project one the user has their own of is `overridden`. */
  async list(userId: string): Promise<SecretSummary[]> {
    const { rows } = await this.db.execute({
      sql: `SELECT s.owner, s.name, s.allowed_hosts, s.description, s.updated_at,
              (s.owner = '' AND ? <> '' AND EXISTS (SELECT 1 FROM secrets p WHERE p.owner = ? AND p.name = s.name)) AS overridden
            FROM secrets s WHERE s.owner IN ('', ?) ORDER BY s.owner <> '', s.name`,
      args: [userId, userId, userId],
    });
    return rows.map((r) => ({
      name: String(r.name),
      scope: r.owner === "" ? "project" : "personal",
      ...(Number(r.overridden) ? { overridden: true } : {}),
      allowedHosts: JSON.parse(String(r.allowed_hosts)) as string[],
      description: String(r.description),
      updatedAt: String(r.updated_at),
    }));
  }

  /** Creates or updates a secret. `value: undefined` keeps the stored value (e.g. when only hosts change). */
  async put(name: string, owner: string, { value, allowedHosts, description }: { value?: string; allowedHosts: string[]; description: string }) {
    if (!SECRET_NAME.test(name)) throw new Error(`Invalid secret name "${name}"`);
    const hosts = JSON.stringify(allowedHosts.map((h) => h.toLowerCase()));
    if (value === undefined) {
      const r = await this.db.execute({
        sql: "UPDATE secrets SET allowed_hosts = ?, description = ?, updated_at = datetime('now') WHERE owner = ? AND name = ?",
        args: [hosts, description, owner, name],
      });
      if (!r.rowsAffected) throw new SecretUseError("errors.secret.valueRequired");
      return;
    }
    await this.db.execute({
      sql: `INSERT INTO secrets (owner, name, value_enc, allowed_hosts, description) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT (owner, name) DO UPDATE SET value_enc = excluded.value_enc, allowed_hosts = excluded.allowed_hosts,
              description = excluded.description, updated_at = datetime('now')`,
      args: [owner, name, this.box.seal(value), hosts, description],
    });
  }

  async delete(name: string, owner: string): Promise<boolean> {
    return (await this.db.execute({ sql: "DELETE FROM secrets WHERE owner = ? AND name = ?", args: [owner, name] })).rowsAffected > 0;
  }

  /**
   * Substitutes `{{secret:NAME}}` in `texts` for a request to `host`. `userId` '' resolves project secrets only
   * (project-wide MCP servers); a user's sub resolves their personal secrets first, then the project's.
   * Throws SecretUseError for an unknown secret or a host the secret isn't allowed for.
   * Returns the filled texts and the values used, for redaction.
   */
  async fill<T extends Record<string, string>>(texts: T, { userId, host }: { userId: string; host: string }) {
    const names = new Set(Object.values(texts).flatMap((t) => [...t.matchAll(SECRET_REF)].map((m) => m[1]!)));
    const values = new Map<string, string>();
    for (const name of names) {
      const { rows } = await this.db.execute({
        sql: "SELECT value_enc, allowed_hosts FROM secrets WHERE name = ? AND owner IN ('', ?) ORDER BY owner = '' LIMIT 1",
        args: [name, userId],
      });
      const r = rows[0];
      if (!r) throw new SecretUseError("errors.secret.notFound", { name });
      if (!hostAllowed(host, JSON.parse(String(r.allowed_hosts)) as string[])) {
        throw new SecretUseError("errors.secret.hostNotAllowed", { name, host });
      }
      values.set(name, this.box.open(String(r.value_enc)));
    }
    const filled = Object.fromEntries(
      Object.entries(texts).map(([k, t]) => [k, t.replace(SECRET_REF, (_, n: string) => values.get(n)!)]),
    ) as T;
    return { filled, used: [...values.values()] };
  }
}
