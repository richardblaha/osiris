import { userDir, type Records } from "../projects/records.ts";
import type { Scope, SecretSummary } from "@osiris/shared";
import type { SecretBox } from "../secrets.ts";
import { hostAllowed, SECRET_NAME, SECRET_REF, SecretUseError } from "./template.ts";

/** Row owner: '' for project-wide secrets, the user's sub for personal ones. */
export const secretOwner = (scope: Scope, userId: string) => (scope === "project" ? "" : userId);

interface StoredSecret {
  valueEnc: string;
  allowedHosts: string[];
  description: string;
  updatedAt: string;
}

const dirOf = (owner: string) => `${owner ? userDir(owner) : "private"}/secrets`;

/**
 * Secrets of one project and its users, one sealed JSON file each. Values are sealed at rest and never leave the
 * server except when substituted into a request to one of the secret's allowed hosts.
 */
export class SecretVault {
  constructor(
    private readonly records: Records,
    private readonly box: SecretBox,
  ) {}

  private read(name: string, owner: string) {
    return SECRET_NAME.test(name) ? this.records.read<StoredSecret>(`${dirOf(owner)}/${name}.json`) : Promise.resolve(undefined);
  }

  /** Project secrets plus `userId`'s personal ones, without values; a project one the user has their own of is `overridden`. */
  async list(userId: string): Promise<SecretSummary[]> {
    const own = userId ? await this.records.all<StoredSecret>(dirOf(userId)) : [];
    const names = new Set(own.map((r) => r.name));
    const summary = (scope: Scope, r: { name: string; value: StoredSecret }): SecretSummary => ({
      name: r.name,
      scope,
      ...(scope === "project" && names.has(r.name) ? { overridden: true } : {}),
      allowedHosts: r.value.allowedHosts,
      description: r.value.description,
      updatedAt: r.value.updatedAt,
    });
    return [...(await this.records.all<StoredSecret>(dirOf(""))).map((r) => summary("project", r)), ...own.map((r) => summary("personal", r))];
  }

  /** Creates or updates a secret. `value: undefined` keeps the stored value (e.g. when only hosts change). */
  async put(name: string, owner: string, { value, allowedHosts, description }: { value?: string; allowedHosts: string[]; description: string }) {
    if (!SECRET_NAME.test(name)) throw new Error(`Invalid secret name "${name}"`);
    const file = `${dirOf(owner)}/${name}.json`;
    await this.records.lock(file, async () => {
      const valueEnc = value === undefined ? (await this.read(name, owner))?.valueEnc : this.box.seal(value);
      if (!valueEnc) throw new SecretUseError("errors.secret.valueRequired");
      await this.records.write(file, { valueEnc, allowedHosts: allowedHosts.map((h) => h.toLowerCase()), description, updatedAt: new Date().toISOString() } satisfies StoredSecret);
    });
  }

  async delete(name: string, owner: string): Promise<boolean> {
    return SECRET_NAME.test(name) && this.records.remove(`${dirOf(owner)}/${name}.json`);
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
      const r = (userId ? await this.read(name, userId) : undefined) ?? (await this.read(name, ""));
      if (!r) throw new SecretUseError("errors.secret.notFound", { name });
      if (!hostAllowed(host, r.allowedHosts)) {
        throw new SecretUseError("errors.secret.hostNotAllowed", { name, host });
      }
      values.set(name, this.box.open(r.valueEnc));
    }
    const filled = Object.fromEntries(
      Object.entries(texts).map(([k, t]) => [k, t.replace(SECRET_REF, (_, n: string) => values.get(n)!)]),
    ) as T;
    return { filled, used: [...values.values()] };
  }
}
