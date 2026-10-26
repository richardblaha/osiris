import { timingSafeEqual, createHash } from "node:crypto";
import { z } from "zod";
import { LocalizedError } from "@osiris/platform/i18n.ts";
import { run, type Db } from "@osiris/platform/rqlite.ts";
import type { SecretBox } from "@osiris/platform/secrets.ts";
import { newToken } from "./secrets.ts";
import { GROUP_NAME } from "./users.ts";

/** An application that signs users in (an OpenID Connect client), as admins register it. */
export interface ClientRecord {
  id: string;
  name: string;
  logo: string | null;
  /** `web` (a site; https redirects) or `native` (a desktop or mobile app; loopback or its own scheme). */
  type: "web" | "native";
  /** Has a secret (a server-side app); otherwise public, with PKCE only. */
  confidential: boolean;
  redirectUris: string[];
  postLogoutRedirectUris: string[];
  /** Groups whose members may sign in; empty = everyone. */
  allowedGroups: string[];
  /** Clients whose access tokens this one may introspect (it is their resource server). */
  acceptsTokensOf: string[];
  createdAt: number;
  updatedAt: number;
}

export class ClientError extends LocalizedError {}

export const CLIENT_ID = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const uri = z.string().trim().min(1).max(500);

export const clientInput = z.object({
  name: z.string().trim().min(1).max(100),
  logo: z.url().max(500).nullable().optional(),
  type: z.enum(["web", "native"]).default("web"),
  confidential: z.boolean().default(false),
  redirectUris: z.array(uri).max(20).default([]),
  postLogoutRedirectUris: z.array(uri).max(20).default([]),
  allowedGroups: z.array(z.string().regex(GROUP_NAME)).max(50).default([]),
  acceptsTokensOf: z.array(z.string().regex(CLIENT_ID)).max(50).default([]),
});
export type ClientInput = z.input<typeof clientInput>;

interface Row {
  id: string;
  name: string;
  logo: string | null;
  metadata: string;
  secret: string | null;
  allowed_groups: string;
  accepts_tokens_of: string;
  created_at: number;
  updated_at: number;
}

type Metadata = { redirect_uris: string[]; post_logout_redirect_uris: string[]; application_type: "web" | "native"; confidential: boolean };

const record = (r: Row): ClientRecord => {
  const m = JSON.parse(r.metadata) as Metadata;
  return {
    id: r.id,
    name: r.name,
    logo: r.logo,
    type: m.application_type,
    confidential: m.confidential,
    redirectUris: m.redirect_uris,
    postLogoutRedirectUris: m.post_logout_redirect_uris,
    allowedGroups: JSON.parse(r.allowed_groups) as string[],
    acceptsTokensOf: JSON.parse(r.accepts_tokens_of) as string[],
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
};

const digest = (s: string) => createHash("sha256").update(s).digest();

/**
 * Registered applications. Secrets are sealed (oidc-provider compares the plain secret, so it can't be a hash) and
 * shown only when made. `validate` is oidc-provider's own check of the metadata, so a client that saves also works.
 */
export class Clients {
  constructor(
    private readonly db: Db,
    private readonly box: SecretBox,
    private readonly validate: (metadata: Record<string, unknown>) => Promise<void> = async () => {},
  ) {}

  private async row(id: string) {
    const [r] = await this.db.query<Row>("SELECT * FROM clients WHERE id = ?", [id], { fresh: true });
    return r;
  }

  async list(): Promise<ClientRecord[]> {
    return (await this.db.query<Row>("SELECT * FROM clients ORDER BY name, id")).map(record);
  }

  async get(id: string): Promise<ClientRecord | null> {
    const r = await this.row(id);
    return r ? record(r) : null;
  }

  /** What oidc-provider needs to know about a client (its adapter's `Client` model). */
  async providerMetadata(id: string): Promise<Record<string, unknown> | undefined> {
    const r = await this.row(id);
    return r ? this.metadataOf(r.id, r.name, r.logo, JSON.parse(r.metadata) as Metadata, r.secret ? this.box.open(r.secret) : undefined) : undefined;
  }

  private metadataOf(id: string, name: string, logo: string | null, m: Metadata, secret?: string): Record<string, unknown> {
    return {
      client_id: id,
      client_name: name,
      ...(logo ? { logo_uri: logo } : {}),
      application_type: m.application_type,
      redirect_uris: m.redirect_uris,
      post_logout_redirect_uris: m.post_logout_redirect_uris,
      grant_types: m.redirect_uris.length ? ["authorization_code", "refresh_token"] : [],
      response_types: m.redirect_uris.length ? ["code"] : [],
      token_endpoint_auth_method: m.confidential ? "client_secret_basic" : "none",
      ...(m.confidential && secret ? { client_secret: secret } : {}),
      id_token_signed_response_alg: "ES256",
    };
  }

  /** Whether `secret` is the client's (introspection: a resource server proving who it is). */
  async checkSecret(id: string, secret: string): Promise<ClientRecord | null> {
    const r = await this.row(id);
    if (!r?.secret) return null;
    return timingSafeEqual(digest(this.box.open(r.secret)), digest(secret)) ? record(r) : null;
  }

  private async check(id: string, input: z.output<typeof clientInput>, secret?: string) {
    const meta: Metadata = { redirect_uris: input.redirectUris, post_logout_redirect_uris: input.postLogoutRedirectUris, application_type: input.type, confidential: input.confidential };
    if (!input.redirectUris.length && !input.acceptsTokensOf.length) throw new ClientError("errors.client.nothing");
    await this.validate(this.metadataOf(id, input.name, input.logo ?? null, meta, input.confidential ? (secret ?? "x".repeat(43)) : undefined)).catch((err: Error & { error_description?: string }) => {
      throw new ClientError("errors.client.invalid", { detail: err.error_description ?? err.message });
    });
    return meta;
  }

  /** Registers an app; the answer carries its secret once (a confidential one). `secret` fixes it (bootstrap). */
  async create(id: string, raw: ClientInput, fixedSecret?: string): Promise<{ client: ClientRecord; secret?: string }> {
    if (!CLIENT_ID.test(id)) throw new ClientError("errors.client.id");
    const input = clientInput.parse(raw);
    const secret = input.confidential ? (fixedSecret ?? newToken()) : undefined;
    const meta = await this.check(id, input, secret);
    const now = Date.now();
    const [res] = await this.db.execute([
      run(
        `INSERT INTO clients (id, name, logo, metadata, secret, allowed_groups, accepts_tokens_of, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO NOTHING`,
        id,
        input.name,
        input.logo ?? null,
        JSON.stringify(meta),
        secret ? this.box.seal(secret) : null,
        JSON.stringify(input.allowedGroups),
        JSON.stringify(input.acceptsTokensOf),
        now,
        now,
      ),
    ]);
    if (!res!.rowsAffected) throw new ClientError("errors.client.exists");
    return { client: (await this.get(id))!, secret };
  }

  /** Changes an app's settings; becoming confidential makes a secret (returned), becoming public drops it. */
  async update(id: string, raw: ClientInput): Promise<{ client: ClientRecord; secret?: string }> {
    const current = await this.row(id);
    if (!current) throw new ClientError("errors.client.notFound");
    const input = clientInput.parse(raw);
    const kept = current.secret ? this.box.open(current.secret) : undefined;
    const secret = input.confidential ? (kept ?? newToken()) : undefined;
    const meta = await this.check(id, input, secret);
    await this.db.execute([
      run(
        "UPDATE clients SET name = ?, logo = ?, metadata = ?, secret = ?, allowed_groups = ?, accepts_tokens_of = ?, updated_at = ? WHERE id = ?",
        input.name,
        input.logo ?? null,
        JSON.stringify(meta),
        secret ? this.box.seal(secret) : null,
        JSON.stringify(input.allowedGroups),
        JSON.stringify(input.acceptsTokensOf),
        Date.now(),
        id,
      ),
    ]);
    return { client: (await this.get(id))!, secret: secret && !kept ? secret : undefined };
  }

  /** A new secret for a confidential app; the old one stops working at once. */
  async rotateSecret(id: string): Promise<string> {
    const current = await this.get(id);
    if (!current) throw new ClientError("errors.client.notFound");
    if (!current.confidential) throw new ClientError("errors.client.public");
    const secret = newToken();
    await this.db.execute([run("UPDATE clients SET secret = ?, updated_at = ? WHERE id = ?", this.box.seal(secret), Date.now(), id)]);
    return secret;
  }

  /** Removes the app with every token and grant it holds. */
  async remove(id: string): Promise<boolean> {
    const [, , res] = await this.db.execute([
      run("DELETE FROM oidc_store WHERE json_extract(payload, '$.clientId') = ?", id),
      run("DELETE FROM oidc_store WHERE model = 'Client' AND id = ?", id),
      run("DELETE FROM clients WHERE id = ?", id),
    ]);
    return res!.rowsAffected > 0;
  }

  /**
   * Whether a link may send the browser to `url`: this provider's own authorization, or the origin of a registered
   * web app's redirect URI (never anywhere else, so links can't be made into open redirects).
   */
  async trustedReturn(url: string, issuer: string): Promise<boolean> {
    if (!URL.canParse(url)) return false;
    const u = new URL(url);
    if (u.origin === issuer) return u.pathname === "/authorize";
    return (await this.list()).some((c) => c.type === "web" && c.redirectUris.some((r) => URL.canParse(r) && new URL(r).origin === u.origin));
  }

  /** Registers apps that aren't there yet; never changes one that is (admins own them afterwards). */
  async ensure(defaults: { id: string; input: ClientInput; secret?: string }[]): Promise<string[]> {
    const added: string[] = [];
    for (const d of defaults) {
      if (await this.row(d.id)) continue;
      await this.create(d.id, d.input, d.secret);
      added.push(d.id);
    }
    return added;
  }
}

/**
 * Osiris's apps, registered at startup when missing: its web app (a redirect per origin), terminal and VS Code
 * clients, and its gateway, which introspects their tokens (with `gatewaySecret`).
 */
export function osirisClients(webOrigins: string[], gatewaySecret?: string): { id: string; input: ClientInput; secret?: string }[] {
  if (!webOrigins.length) return [];
  const apps = ["osiris-web", "osiris-cli", "osiris-vscode"];
  return [
    { id: "osiris-web", input: { name: "Osiris", redirectUris: webOrigins.map((o) => `${o}/callback`), postLogoutRedirectUris: webOrigins } },
    { id: "osiris-cli", input: { name: "Osiris CLI", type: "native", redirectUris: ["http://127.0.0.1/callback"] } },
    { id: "osiris-vscode", input: { name: "Osiris for VS Code", type: "native", redirectUris: ["vscode://osiris.osiris-vscode/callback", "http://127.0.0.1/callback"] } },
    ...(gatewaySecret ? [{ id: "osiris-gateway", input: { name: "Osiris gateway", confidential: true, acceptsTokensOf: apps }, secret: gatewaySecret }] : []),
  ];
}
