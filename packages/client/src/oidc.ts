import { createHash, randomBytes } from "node:crypto";

// Signing in to osiris-server as a native app (RFC 8252, authorization code with PKCE): the parts the terminal client
// and the VS Code extension share. Where they keep the tokens is theirs.

export interface OidcTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

const discover = async (server: string) =>
  (await (await fetch(`${server}/auth/.well-known/openid-configuration`)).json()) as { authorization_endpoint: string; token_endpoint: string };

/** Where to send the browser, with the verifier and state to keep until it comes back. */
export async function signInUrl(server: string, clientId: string, redirect: string) {
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(16).toString("base64url");
  const url = `${(await discover(server)).authorization_endpoint}?${new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirect,
    response_type: "code",
    scope: "openid profile email",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    state,
  })}`;
  return { url, verifier, state };
}

/** Exchanges a code or a refresh token at the server; a server that doesn't rotate keeps `refreshToken`. */
export async function requestTokens(server: string, clientId: string, params: Record<string, string>, refreshToken = ""): Promise<OidcTokens> {
  const res = await fetch((await discover(server)).token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, ...params }),
  });
  const body = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!res.ok || !body.access_token) throw new Error(`Sign-in failed: ${body.error_description ?? body.error ?? res.status}`);
  return { accessToken: body.access_token, refreshToken: body.refresh_token ?? refreshToken, expiresAt: Date.now() + (body.expires_in ?? 600) * 1000 };
}

/** The access token while it's good for another minute, else a refreshed one (`save` keeps it), else undefined. */
export async function freshToken(server: string, clientId: string, tokens: OidcTokens | undefined, save: (t: OidcTokens) => Promise<void> | void): Promise<string | undefined> {
  if (!tokens) return undefined;
  if (tokens.expiresAt - 60_000 > Date.now()) return tokens.accessToken;
  const fresh = await requestTokens(server, clientId, { grant_type: "refresh_token", refresh_token: tokens.refreshToken }, tokens.refreshToken).catch(() => undefined);
  if (fresh) await save(fresh);
  return fresh?.accessToken;
}
