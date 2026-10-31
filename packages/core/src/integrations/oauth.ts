import { newState, pkcePair } from "@osiris/shared/pkce.ts";
import { userDir, userIds, type Records } from "../projects/records.ts";
import type { SecretBox } from "../secrets.ts";
import { LocalizedError } from "@osiris/platform/i18n.ts";

export type IntegrationProvider = "google" | "microsoft";

/** An OAuth client Osiris registered at the provider (Google Cloud, Microsoft Entra). */
export interface IntegrationClient {
  clientId: string;
  clientSecret: string;
}

interface ProviderConfig {
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string[];
  /** Extra authorization parameters (Google needs these for a refresh token). */
  extra?: Record<string, string>;
  /** The signed-in account's address, from the provider's API. */
  account: (token: string, fetchFn: typeof fetch) => Promise<string | null>;
}

export const PROVIDERS: Record<IntegrationProvider, ProviderConfig> = {
  google: {
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scopes: [
      "openid",
      "email",
      "https://www.googleapis.com/auth/gmail.modify",
      "https://www.googleapis.com/auth/contacts",
      "https://www.googleapis.com/auth/calendar.events",
    ],
    extra: { access_type: "offline", prompt: "consent", include_granted_scopes: "true" },
    account: async (token, fetchFn) => {
      const res = await fetchFn("https://openidconnect.googleapis.com/v1/userinfo", { headers: { authorization: `Bearer ${token}` } });
      return res.ok ? ((await res.json()) as { email?: string }).email ?? null : null;
    },
  },
  microsoft: {
    authorizeUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    scopes: ["offline_access", "openid", "email", "User.Read", "Mail.ReadWrite", "Mail.Send", "Contacts.ReadWrite", "Calendars.ReadWrite"],
    extra: { prompt: "select_account" },
    account: async (token, fetchFn) => {
      const res = await fetchFn("https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName", { headers: { authorization: `Bearer ${token}` } });
      if (!res.ok) return null;
      const me = (await res.json()) as { mail?: string | null; userPrincipalName?: string };
      return me.mail ?? me.userPrincipalName ?? null;
    },
  },
};

interface Tokens {
  access_token: string;
  refresh_token?: string;
  /** ms */
  expires_at: number;
}

interface Data {
  tokens?: Tokens;
  verifier?: string;
}

/** The account has to be connected (again): never was, or the provider revoked it. */
export class NotConnectedError extends LocalizedError {}

/**
 * Users' connections to Google and Microsoft: authorization code with PKCE against Osiris's own OAuth clients, the
 * tokens sealed with the project's key and refreshed when they expire.
 */
export class IntegrationAccounts {
  constructor(
    private readonly records: Records,
    private readonly box: SecretBox,
    private readonly clients: Partial<Record<IntegrationProvider, IntegrationClient>>,
    /** The web app's `/integration-callback`. */
    private readonly redirectUrl: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  /** Providers Osiris has a client for. */
  available(): IntegrationProvider[] {
    return (Object.keys(PROVIDERS) as IntegrationProvider[]).filter((p) => this.clients[p]);
  }

  private client(provider: IntegrationProvider) {
    const client = this.clients[provider];
    if (!client) throw new LocalizedError("errors.integration.notConfigured", { provider });
    return client;
  }

  private file = (owner: string, provider: IntegrationProvider) => `${userDir(owner)}/integrations/${provider}.json`;

  private async read(owner: string, provider: IntegrationProvider) {
    const r = await this.records.read<{ account: string | null; dataEnc: string }>(this.file(owner, provider));
    return r ? { account: r.account, data: JSON.parse(this.box.open(r.dataEnc)) as Data } : undefined;
  }

  private async write(owner: string, provider: IntegrationProvider, data: Data, fields: { account?: string | null; state?: string | null }) {
    await this.records.update<{ account: string | null; dataEnc: string; state: string | null }>(this.file(owner, provider), (current) => ({
      account: fields.account === undefined ? (current?.account ?? null) : fields.account,
      state: fields.state === undefined ? (current?.state ?? null) : fields.state,
      dataEnc: this.box.seal(JSON.stringify(data)),
    }));
  }

  /** The user's connections, by provider: the account's address, or absent when not connected. */
  async list(owner: string): Promise<{ provider: IntegrationProvider; account: string | null; connected: boolean }[]> {
    return Promise.all(
      this.available().map(async (provider) => {
        const r = await this.read(owner, provider);
        const connected = !!r?.data.tokens;
        return { provider, account: connected ? (r?.account ?? null) : null, connected };
      }),
    );
  }

  async connected(owner: string): Promise<IntegrationProvider[]> {
    return (await this.list(owner)).filter((c) => c.connected).map((c) => c.provider);
  }

  /** The provider's sign-in URL to send the user to. */
  async start(owner: string, provider: IntegrationProvider): Promise<string> {
    const { clientId } = this.client(provider);
    const config = PROVIDERS[provider];
    const { verifier, challenge } = pkcePair();
    const state = newState(24);
    const existing = await this.read(owner, provider);
    await this.write(owner, provider, { ...existing?.data, verifier }, { state });
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: this.redirectUrl,
      response_type: "code",
      scope: config.scopes.join(" "),
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      ...config.extra,
    });
    return `${config.authorizeUrl}?${params}`;
  }

  /** Whose sign-in waits for this state value. */
  async pending(state: string): Promise<{ owner: string; provider: IntegrationProvider } | undefined> {
    for (const owner of await userIds(this.records)) {
      for (const provider of Object.keys(PROVIDERS) as IntegrationProvider[]) {
        if ((await this.records.read<{ state?: string | null }>(this.file(owner, provider)))?.state === state) return { owner, provider };
      }
    }
    return undefined;
  }

  /** Exchanges the code the provider sent the user back with; returns the connected account. */
  async finish(state: string, code: string): Promise<{ owner: string; provider: IntegrationProvider; account: string | null }> {
    const pending = await this.pending(state);
    if (!pending) throw new LocalizedError("errors.integration.expired");
    const { owner, provider } = pending;
    const stored = await this.read(owner, provider);
    if (!stored?.data.verifier) throw new LocalizedError("errors.integration.notStarted");
    const tokens = await this.token(provider, {
      grant_type: "authorization_code",
      code,
      redirect_uri: this.redirectUrl,
      code_verifier: stored.data.verifier,
    });
    const account = await PROVIDERS[provider].account(tokens.access_token, this.fetchFn).catch(() => null);
    await this.write(owner, provider, { tokens }, { account, state: null });
    return { owner, provider, account };
  }

  async disconnect(owner: string, provider: IntegrationProvider) {
    await this.records.remove(this.file(owner, provider));
  }

  /** A valid access token for the user's account, refreshed when it's about to expire. */
  async accessToken(owner: string, provider: IntegrationProvider): Promise<string> {
    const stored = await this.read(owner, provider);
    const tokens = stored?.data.tokens;
    if (!tokens) throw new NotConnectedError("errors.integration.notConnected", { provider });
    if (tokens.expires_at - 60_000 > Date.now()) return tokens.access_token;
    if (!tokens.refresh_token) throw new NotConnectedError("errors.integration.reconnect", { provider });
    const fresh = await this.token(provider, { grant_type: "refresh_token", refresh_token: tokens.refresh_token }).catch((err: Error) => {
      throw new NotConnectedError("errors.integration.revoked", { provider, detail: err.message });
    });
    // Google keeps the refresh token the same and doesn't send it again.
    await this.write(owner, provider, { tokens: { ...fresh, refresh_token: fresh.refresh_token ?? tokens.refresh_token } }, {});
    return fresh.access_token;
  }

  private async token(provider: IntegrationProvider, params: Record<string, string>): Promise<Tokens> {
    const { clientId, clientSecret } = this.client(provider);
    const res = await this.fetchFn(PROVIDERS[provider].tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ ...params, client_id: clientId, client_secret: clientSecret }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; error_description?: string; error?: string };
    if (!res.ok || !body.access_token) throw new Error(body.error_description ?? body.error ?? `HTTP ${res.status}`);
    return { access_token: body.access_token, refresh_token: body.refresh_token, expires_at: Date.now() + (body.expires_in ?? 3600) * 1000 };
  }
}
