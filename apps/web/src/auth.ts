import { UserManager, WebStorageStateStore } from "oidc-client-ts";

const devUser = (import.meta.env.VITE_DEV_USER as string | undefined) || undefined;
declare global {
  interface Window {
    /** Set by `/config.js`, which the API serves in production. */
    __OSIRIS_CONFIG__?: { oidcAuthority?: string; oidcClientId?: string };
  }
}
const runtime = window.__OSIRIS_CONFIG__;
const authority = runtime?.oidcAuthority || (import.meta.env.VITE_OIDC_AUTHORITY as string | undefined);
const clientId = runtime?.oidcClientId || (import.meta.env.VITE_OIDC_CLIENT_ID as string | undefined);

/** Set when neither dev login nor PocketID is configured, so the UI can say what's missing. */
export const configError =
  devUser || (authority && clientId)
    ? undefined
    : "Chybí nastavení přihlášení: v apps/web/.env vyplň VITE_OIDC_AUTHORITY a VITE_OIDC_CLIENT_ID, nebo pro vývoj VITE_DEV_USER.";

const manager =
  devUser || configError
    ? undefined
    : new UserManager({
        authority: authority!,
        client_id: clientId!,
        redirect_uri: `${location.origin}/callback`,
        post_logout_redirect_uri: location.origin,
        // profile carries the custom claims: role, tenant, tenant-admin and phone_number.
        scope: "openid profile email",
        userStore: new WebStorageStateStore({ store: localStorage }),
        automaticSilentRenew: true,
      });

/** Completes the redirect from PocketID if we're on /callback. */
export async function handleCallback(): Promise<void> {
  if (manager && location.pathname === "/callback") {
    await manager.signinRedirectCallback();
    history.replaceState(null, "", "/");
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
  if (!manager) throw new Error(configError);
  await manager.signinRedirect();
};
export const logout = () => manager?.signoutRedirect();
