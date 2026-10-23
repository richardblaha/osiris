import { LAST_PATH } from "./routes.ts";
import { UserManager, WebStorageStateStore } from "oidc-client-ts";
import { t } from "i18next";

const devUser = (import.meta.env.VITE_DEV_USER as string | undefined) || undefined;

const manager = devUser
  ? undefined
  : new UserManager({
      // Control's OpenID Connect provider, on this origin behind the gateway.
      authority: `${location.origin}/auth`,
      client_id: "osiris-web",
      redirect_uri: `${location.origin}/callback`,
      post_logout_redirect_uri: location.origin,
      // profile carries the claims role, project, project-admin and phone_number.
      scope: "openid profile email",
      userStore: new WebStorageStateStore({ store: localStorage }),
      // Renews with the refresh token, which lives as long as the sign-in session.
      automaticSilentRenew: true,
    });

/** Where to go after signing in, carried through the redirect as OIDC state. */
type ReturnState = { path?: string };

/**
 * Completes the redirect back from sign-in if we're on /callback, and starts a fresh sign-in when a one-time link
 * sent us here (`/?signin=link`; the link was remembered by the server, the sign-in uses it up).
 */
export async function handleCallback(): Promise<void> {
  if (!manager) return;
  if (location.pathname === "/callback") {
    const user = await manager.signinRedirectCallback();
    history.replaceState(null, "", (user.state as ReturnState | undefined)?.path ?? "/");
    return;
  }
  const params = new URLSearchParams(location.search);
  if (params.get("signin") === "link") {
    await manager.removeUser();
    // prompt=login: sign in as the link's user even if this browser is signed in as someone else.
    await manager.signinRedirect({ prompt: "login", state: { path: "/?profile=security" } satisfies ReturnState });
  }
}

/** Current access token, or undefined when logged out or expired. */
export async function getAccessToken(): Promise<string | undefined> {
  if (devUser) return devUser;
  if (!manager) return undefined;
  const user = await manager.getUser();
  return user && !user.expired ? user.access_token : undefined;
}

export const login = async () => {
  if (!manager) throw new Error(t("auth.unavailable"));
  await manager.signinRedirect({ state: { path: `${location.pathname}${location.search}` } satisfies ReturnState });
};
export const logout = () => {
  try {
    localStorage.removeItem(LAST_PATH);
  } catch {
    // Storage unavailable: nothing was remembered.
  }
  return manager?.signoutRedirect();
};
