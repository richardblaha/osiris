import { randomBytes } from "node:crypto";
import { userDir, userIds, type Records } from "../projects/records.ts";
import {
  auth,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import type { SecretBox } from "../secrets.ts";
import { LocalizedError } from "@osiris/platform/i18n.ts";

interface OAuthData {
  client?: StoredOAuthClientInformation;
  tokens?: StoredOAuthTokens;
  verifier?: string;
}

const oauthDir = (owner: string) => `${owner ? userDir(owner) : "private"}/mcp-oauth`;

/** OAuth sign-ins to MCP servers, per server and owner ('' = project-wide, or a user's sub); sealed with the SecretBox. */
export class McpOAuthStore {
  constructor(
    private readonly records: Records,
    private readonly secrets: SecretBox,
  ) {}

  async get(owner: string, name: string): Promise<OAuthData> {
    const r = await this.records.read<{ dataEnc: string }>(`${oauthDir(owner)}/${name}.json`);
    return r ? (JSON.parse(this.secrets.open(r.dataEnc)) as OAuthData) : {};
  }

  /** Merges changes into the stored data (a key set to undefined is removed); `state` replaces the pending state. */
  async patch(owner: string, name: string, changes: Partial<OAuthData>, state?: string | null) {
    const file = `${oauthDir(owner)}/${name}.json`;
    await this.records.lock(file, async () => {
      const data: OAuthData = { ...(await this.get(owner, name)), ...changes };
      for (const k of Object.keys(changes) as (keyof OAuthData)[]) if (changes[k] === undefined) delete data[k];
      const kept = state === undefined ? ((await this.records.read<{ state?: string | null }>(file))?.state ?? null) : state;
      await this.records.write(file, { dataEnc: this.secrets.seal(JSON.stringify(data)), state: kept });
    });
  }

  /** The server whose sign-in is waiting for this state value. */
  async byState(state: string): Promise<{ owner: string; name: string } | undefined> {
    for (const owner of ["", ...(await userIds(this.records))]) {
      const found = (await this.records.all<{ state?: string | null }>(oauthDir(owner))).find((r) => r.value.state === state);
      if (found) return { owner, name: found.name };
    }
    return undefined;
  }

  async connected(owner: string, name: string): Promise<boolean> {
    return !!(await this.get(owner, name)).tokens;
  }

  async clear(owner: string, name: string) {
    await this.records.remove(`${oauthDir(owner)}/${name}.json`);
  }
}

/**
 * The MCP SDK's OAuth client for one server and owner, over the store: dynamic client registration, PKCE, tokens
 * and their refresh are the SDK's; this keeps what it needs between the redirect and the provider's return. A
 * redirect is never followed here: the URL is kept for the web app to send the user to.
 */
export class StoredOAuthProvider implements OAuthClientProvider {
  /** Set when the SDK wants the user to sign in. */
  authorizationUrl?: URL;

  constructor(
    private readonly store: McpOAuthStore,
    private readonly owner: string,
    private readonly name: string,
    private readonly redirect: string,
  ) {}

  get redirectUrl() {
    return this.redirect;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Osiris",
      redirect_uris: [this.redirect],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  async state() {
    const state = randomBytes(24).toString("base64url");
    await this.store.patch(this.owner, this.name, {}, state);
    return state;
  }

  async clientInformation() {
    return (await this.store.get(this.owner, this.name)).client;
  }

  async saveClientInformation(client: StoredOAuthClientInformation) {
    await this.store.patch(this.owner, this.name, { client });
  }

  async tokens() {
    return (await this.store.get(this.owner, this.name)).tokens;
  }

  async saveTokens(tokens: StoredOAuthTokens) {
    // Signed in: the pending sign-in is done.
    await this.store.patch(this.owner, this.name, { tokens, verifier: undefined }, null);
  }

  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url;
  }

  async saveCodeVerifier(verifier: string) {
    await this.store.patch(this.owner, this.name, { verifier });
  }

  async codeVerifier() {
    const { verifier } = await this.store.get(this.owner, this.name);
    if (!verifier) throw new LocalizedError("errors.mcp.signInNotStarted");
    return verifier;
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery") {
    if (scope === "all") return this.store.clear(this.owner, this.name);
    if (scope === "client") return this.store.patch(this.owner, this.name, { client: undefined, tokens: undefined });
    if (scope === "tokens") return this.store.patch(this.owner, this.name, { tokens: undefined });
    if (scope === "verifier") return this.store.patch(this.owner, this.name, { verifier: undefined });
  }
}

/** Starts signing in: the URL to send the user to, or null when the stored tokens still work. */
export async function startOAuth(provider: StoredOAuthProvider, serverUrl: string, fetchFn?: typeof fetch): Promise<URL | null> {
  const result = await auth(provider, { serverUrl, fetchFn });
  return result === "REDIRECT" ? (provider.authorizationUrl ?? null) : null;
}

/** Finishes signing in with the code the provider sent the user back with. */
export async function finishOAuth(provider: StoredOAuthProvider, serverUrl: string, code: string, iss?: string, fetchFn?: typeof fetch) {
  const result = await auth(provider, { serverUrl, authorizationCode: code, iss, fetchFn });
  if (result !== "AUTHORIZED") throw new LocalizedError("errors.mcp.signInFailed");
}
