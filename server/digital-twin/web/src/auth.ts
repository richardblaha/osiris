import { UserManager, WebStorageStateStore } from "oidc-client-ts";

/** Where users sign in: osiris-auth, named by the server (`/auth-config.json`). */
const authConfig =
  await fetch("/auth-config.json")
    .then((r) => (r.ok ? (r.json() as Promise<{ issuer: string; clientId: string } | null>) : null))
    .catch(() => null);

/** Development without osiris-auth: no OIDC, every request goes without a token. */
export const authOff = !authConfig;
/** The identity provider's own pages (the user's account). */
export const accountUrl = authConfig ? `${authConfig.issuer.replace(/\/$/, "")}/account` : undefined;

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
      // The picture and name come from userinfo.
      loadUserInfo: true,
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

/** The signed-in user's name, email and picture, from the ID token. */
export async function profile(): Promise<{ name?: string; email?: string; picture?: string } | undefined> {
  const user = await manager?.getUser();
  if (!user || user.expired) return undefined;
  const { name, email, picture, preferred_username } = user.profile;
  // A picture may be a path on the identity provider.
  const url = picture && authConfig ? new URL(picture, authConfig.issuer).href : picture;
  return { name: name ?? preferred_username, email, picture: url };
}

const ATTEMPT = "twin.signInAttempt";
/**
 * Signs in without a click: off to osiris-auth at once (back to the same view), unless that was tried in the last
 * minute and came back without a token (a refused or failed sign-in), so it never loops. True when it redirects.
 */
export function autoSignIn(path = location.hash || "#/"): boolean {
  if (!manager) return false;
  try {
    const last = Number(sessionStorage.getItem(ATTEMPT) ?? 0);
    if (Date.now() - last < 60_000) return false;
    sessionStorage.setItem(ATTEMPT, String(Date.now()));
  } catch {
    // Without storage it can't tell a loop: no automatic sign-in.
    return false;
  }
  void login(path);
  return true;
}
/** A sign-in went through: the next one may start on its own again. */
export function signedInOk() {
  try {
    sessionStorage.removeItem(ATTEMPT);
  } catch {
    // Nothing to forget.
  }
}

export async function logout(): Promise<void> {
  await manager?.signoutRedirect();
}
