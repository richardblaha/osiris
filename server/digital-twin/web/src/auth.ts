import { UserManager, WebStorageStateStore } from "oidc-client-ts";

/** Where users sign in: osiris-auth, named by the server (`/auth-config.json`). */
const authConfig =
  await fetch("/auth-config.json")
    .then((r) => (r.ok ? (r.json() as Promise<{ issuer: string; clientId: string } | null>) : null))
    .catch(() => null);

/** Development without osiris-auth: no OIDC, every request goes without a token. */
export const authOff = !authConfig;

const manager = !authConfig
  ? undefined
  : new UserManager({
      authority: authConfig.issuer,
      client_id: authConfig.clientId,
      redirect_uri: `${location.origin}/callback`,
      post_logout_redirect_uri: location.origin,
      scope: "openid profile email",
      userStore: new WebStorageStateStore({ store: localStorage }),
      // Renews with the refresh token, which lives as long as the sign-in session.
      automaticSilentRenew: true,
    });

/** Completes the redirect back from sign-in if we're on /callback. */
export async function handleCallback(): Promise<string | undefined> {
  if (!manager || location.pathname !== "/callback") return undefined;
  const user = await manager.signinRedirectCallback();
  const back = (user.state as { path?: string } | undefined)?.path ?? "/";
  history.replaceState(null, "", back);
  return back;
}

/** Current access token, or undefined when logged out or expired. */
export async function getAccessToken(): Promise<string | undefined> {
  if (!manager) return undefined;
  const user = await manager.getUser();
  return user && !user.expired ? user.access_token : undefined;
}

export async function login(path = location.hash || "#/"): Promise<void> {
  await manager?.signinRedirect({ state: { path } });
}

export async function logout(): Promise<void> {
  await manager?.signoutRedirect();
}
