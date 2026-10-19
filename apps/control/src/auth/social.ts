import { createHash, createHmac } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { SOCIAL_PROVIDERS, type SocialProvider as SocialProviderId } from "@osiris/shared";

export { SOCIAL_PROVIDERS, type SocialProviderId };

export interface SocialClient {
  clientId: string;
  clientSecret: string;
  /** Microsoft only: `common` (any account), `consumers`, `organizations` or one directory's id. */
  tenant?: string;
}

/** Who signed in at the provider. */
export interface SocialProfile {
  subject: string;
  email: string | null;
  /** The provider vouches for the address, so it may match an existing Osiris user by email. */
  emailVerified: boolean;
  firstName: string;
  lastName: string;
}

export interface AuthorizeState {
  state: string;
  nonce: string;
  /** PKCE code verifier. */
  verifier: string;
}

export class SocialLoginError extends Error {}

const challenge = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");
const str = (v: unknown) => (typeof v === "string" ? v : "");
const FACEBOOK_GRAPH = "https://graph.facebook.com/v23.0";
const SEZNAM = "https://login.szn.cz/api/v1";
/** Mailboxes Seznam hosts itself; a Seznam account can also carry an outside address, which we don't take as proven. */
const SEZNAM_MAIL_DOMAINS = new Set(["seznam.cz", "email.cz", "post.cz", "spoluzaci.cz", "stream.cz", "firmy.cz"]);

/**
 * Sign-in with Google, Facebook, Microsoft and Seznam: the authorization code flow (with PKCE where the provider
 * supports it) against each provider, ending in a verified profile. Google and Microsoft return an ID token checked
 * against their keys; Facebook a profile from the Graph API, Seznam from its user API.
 */
export class SocialLogin {
  private readonly jwks = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

  constructor(
    private readonly clients: Partial<Record<SocialProviderId, SocialClient>>,
    /** `<origin>/auth/social`; each provider calls back to `<base>/<provider>/callback`. */
    private readonly callbackBase: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  enabled(): SocialProviderId[] {
    return SOCIAL_PROVIDERS.filter((p) => this.clients[p]);
  }

  redirectUri = (provider: SocialProviderId) => `${this.callbackBase}/${provider}/callback`;

  private client(provider: SocialProviderId) {
    const client = this.clients[provider];
    if (!client) throw new SocialLoginError(`Přihlášení přes ${provider} není nastavené`);
    return client;
  }

  private keys(url: string) {
    let set = this.jwks.get(url);
    if (!set) this.jwks.set(url, (set = createRemoteJWKSet(new URL(url))));
    return set;
  }

  authorizeUrl(provider: SocialProviderId, s: AuthorizeState): string {
    const client = this.client(provider);
    const common = { client_id: client.clientId, redirect_uri: this.redirectUri(provider), response_type: "code", state: s.state };
    const pkce = { code_challenge: challenge(s.verifier), code_challenge_method: "S256" };
    switch (provider) {
      case "google":
        return `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({ ...common, ...pkce, scope: "openid email profile", nonce: s.nonce, prompt: "select_account" })}`;
      case "microsoft":
        return `https://login.microsoftonline.com/${client.tenant ?? "common"}/oauth2/v2.0/authorize?${new URLSearchParams({ ...common, ...pkce, scope: "openid email profile", nonce: s.nonce, prompt: "select_account", response_mode: "query" })}`;
      case "facebook":
        return `https://www.facebook.com/v23.0/dialog/oauth?${new URLSearchParams({ ...common, scope: "email public_profile" })}`;
      case "seznam":
        return `${SEZNAM}/oauth/auth?${new URLSearchParams({ ...common, scope: "identity" })}`;
    }
  }

  async profile(provider: SocialProviderId, code: string, s: Pick<AuthorizeState, "nonce" | "verifier">): Promise<SocialProfile> {
    const client = this.client(provider);
    if (provider === "facebook") return this.facebook(client, code);
    if (provider === "seznam") return this.seznam(client, code);

    const tokenUrl =
      provider === "google" ? "https://oauth2.googleapis.com/token" : `https://login.microsoftonline.com/${client.tenant ?? "common"}/oauth2/v2.0/token`;
    const tokens = await this.call<{ id_token?: string }>(tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: this.redirectUri(provider),
        client_id: client.clientId,
        client_secret: client.clientSecret,
        code_verifier: s.verifier,
      }),
    });
    if (!tokens.id_token) throw new SocialLoginError("Poskytovatel nevrátil ID token");

    const claims = provider === "google" ? await this.verifyGoogle(tokens.id_token, client) : await this.verifyMicrosoft(tokens.id_token, client);
    if (claims.nonce !== s.nonce) throw new SocialLoginError("Neplatná odpověď poskytovatele (nonce)");
    const [first = "", ...rest] = str(claims.name).split(" ");
    const email = str(claims.email) || (provider === "microsoft" ? str(claims.preferred_username) : "");
    return {
      subject: String(claims.sub),
      email: email.includes("@") ? email.toLowerCase() : null,
      // Microsoft doesn't verify the addresses in its tokens (anyone can put any address on an Entra account).
      emailVerified: provider === "google" && claims.email_verified === true,
      firstName: str(claims.given_name) || first,
      lastName: str(claims.family_name) || rest.join(" "),
    };
  }

  private async verifyGoogle(idToken: string, client: SocialClient) {
    const { payload } = await jwtVerify(idToken, this.keys("https://www.googleapis.com/oauth2/v3/certs"), {
      issuer: ["https://accounts.google.com", "accounts.google.com"],
      audience: client.clientId,
    }).catch((err: Error) => {
      throw new SocialLoginError(`Neplatný token od Googlu: ${err.message}`);
    });
    return payload;
  }

  /** Microsoft's multi-tenant endpoint issues tokens per directory: the issuer must match the token's own `tid`. */
  private async verifyMicrosoft(idToken: string, client: SocialClient) {
    const tenant = client.tenant ?? "common";
    const { payload } = await jwtVerify<JWTPayload & { tid?: string }>(idToken, this.keys(`https://login.microsoftonline.com/${tenant}/discovery/v2.0/keys`), {
      audience: client.clientId,
    }).catch((err: Error) => {
      throw new SocialLoginError(`Neplatný token od Microsoftu: ${err.message}`);
    });
    const tid = str(payload.tid);
    if (!tid || payload.iss !== `https://login.microsoftonline.com/${tid}/v2.0`) throw new SocialLoginError("Neplatný vydavatel tokenu Microsoftu");
    if (!["common", "organizations", "consumers"].includes(tenant) && tid !== tenant) throw new SocialLoginError("Účet z jiné organizace");
    return payload;
  }

  private async facebook(client: SocialClient, code: string): Promise<SocialProfile> {
    const { access_token } = await this.call<{ access_token?: string }>(
      `${FACEBOOK_GRAPH}/oauth/access_token?${new URLSearchParams({
        client_id: client.clientId,
        client_secret: client.clientSecret,
        redirect_uri: this.redirectUri("facebook"),
        code,
      })}`,
    );
    if (!access_token) throw new SocialLoginError("Facebook nevrátil přístupový token");
    const proof = createHmac("sha256", client.clientSecret).update(access_token).digest("hex");
    const me = await this.call<{ id?: string; email?: string; first_name?: string; last_name?: string }>(
      `${FACEBOOK_GRAPH}/me?${new URLSearchParams({ fields: "id,email,first_name,last_name", access_token, appsecret_proof: proof })}`,
    );
    if (!me.id) throw new SocialLoginError("Facebook nevrátil profil");
    return {
      subject: me.id,
      email: me.email?.toLowerCase() ?? null,
      // Facebook hands out confirmed addresses only.
      emailVerified: !!me.email,
      firstName: me.first_name ?? "",
      lastName: me.last_name ?? "",
    };
  }

  private async seznam(client: SocialClient, code: string): Promise<SocialProfile> {
    const { access_token } = await this.call<{ access_token?: string }>(`${SEZNAM}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: this.redirectUri("seznam"),
        client_id: client.clientId,
        client_secret: client.clientSecret,
      }),
    });
    if (!access_token) throw new SocialLoginError("Seznam nevrátil přístupový token");
    const me = await this.call<{ oauth_user_id?: string; email?: string | null; firstname?: string; lastname?: string }>(`${SEZNAM}/user`, {
      headers: { authorization: `bearer ${access_token}` },
    });
    if (!me.oauth_user_id) throw new SocialLoginError("Seznam nevrátil profil");
    const email = me.email?.includes("@") ? me.email.toLowerCase() : null;
    return {
      subject: String(me.oauth_user_id),
      email,
      emailVerified: !!email && SEZNAM_MAIL_DOMAINS.has(email.split("@")[1]!),
      firstName: me.firstname ?? "",
      lastName: me.lastname ?? "",
    };
  }

  private async call<T>(url: string, init: RequestInit = {}): Promise<T> {
    const res = await this.fetchFn(url, { ...init, headers: { accept: "application/json", ...init.headers }, signal: AbortSignal.timeout(10_000) });
    const body = (await res.json().catch(() => ({}))) as T & { error?: unknown; error_description?: string };
    if (!res.ok) {
      const detail = body.error_description ?? (typeof body.error === "string" ? body.error : JSON.stringify(body.error ?? res.status));
      throw new SocialLoginError(`Poskytovatel odmítl přihlášení: ${detail}`);
    }
    return body;
  }
}
