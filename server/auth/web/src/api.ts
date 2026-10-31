import type { AccountActivity, SecurityOverview, SocialProvider } from "@osiris/shared";
import type { startRegistration } from "@simplewebauthn/browser";
import { currentLocale } from "./i18n.ts";

// The provider's own API, on this origin: the browser's sign-in session (a cookie) says who calls.

type PasskeyCreationOptions = Parameters<typeof startRegistration>[0]["optionsJSON"];

export interface Config {
  name: string;
  logo: string | null;
  user: { id: string; name: string | null; email: string | null; picture: string | null } | null;
  admin: boolean;
}

export interface Profile {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  picture: string | null;
}

export interface Client {
  id: string;
  name: string;
  logo: string | null;
  type: "web" | "native";
  confidential: boolean;
  redirectUris: string[];
  postLogoutRedirectUris: string[];
  allowedGroups: string[];
  acceptsTokensOf: string[];
  /** The user a confidential service acts as (client credentials), if any. */
  serviceAccount: string | null;
}
export type ClientInput = Omit<Client, "id">;

/** A SCIM user or group, the parts the admin pages show. */
export interface ScimUser {
  id: string;
  userName: string;
  name: { givenName?: string; familyName?: string };
  active: boolean;
  emails: { value: string }[];
  phoneNumbers: { value: string }[];
  photos: { value: string }[];
  groups: { value: string }[];
}
export interface ScimGroup {
  id: string;
  members: { value: string }[];
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(path, {
    ...init,
    headers: { "accept-language": currentLocale(), ...(typeof init.body === "string" ? { "content-type": "application/json" } : {}), ...init.headers },
  });
  if (res.status === 401 && !path.startsWith("/api/config")) {
    window.location.assign("/account/signin");
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string; detail?: string } | null;
    throw new ApiError(body?.error ?? body?.detail ?? `HTTP ${res.status}`, res.status);
  }
  return res;
}
const json = async <T>(path: string, init?: RequestInit) => (await request(path, init)).json() as Promise<T>;
const send = (method: string, body?: unknown): RequestInit => ({ method, body: body === undefined ? undefined : JSON.stringify(body) });
const PATCH_OP = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
const scimPath = (kind: "Users" | "Groups", id: string) => `/scim/v2/${kind}/${encodeURIComponent(id)}`;

export const api = {
  config: () => json<Config>("/api/config"),
  profile: () => json<Profile>("/api/me/profile"),
  saveProfile: (changes: Partial<Pick<Profile, "firstName" | "lastName" | "email">>) => json<Profile>("/api/me/profile", send("PATCH", changes)),
  savePicture: (image: Blob) => request("/api/me/picture", { method: "PUT", body: image, headers: { "content-type": image.type } }),

  security: {
    activity: () => json<AccountActivity>("/api/me/security/activity"),
    revokeSession: (id: string) => request(`/api/me/security/sessions/${encodeURIComponent(id)}`, send("DELETE")),
    get: () => json<SecurityOverview>("/api/me/security"),
    setPassword: (password: string, current?: string) => json<SecurityOverview>("/api/me/security/password", send("PUT", { password, current })),
    removePassword: () => json<SecurityOverview>("/api/me/security/password", send("DELETE")),
    passkeyOptions: () => json<PasskeyCreationOptions>("/api/me/security/passkeys/options", send("POST")),
    addPasskey: (response: unknown, name: string) => json<SecurityOverview>("/api/me/security/passkeys", send("POST", { response, name })),
    removePasskey: (id: string) => json<SecurityOverview>(`/api/me/security/passkeys/${encodeURIComponent(id)}`, send("DELETE")),
    startTotp: () => json<{ secret: string; url: string }>("/api/me/security/totp", send("POST")),
    confirmTotp: (code: string) => json<{ recoveryCodes: string[]; security: SecurityOverview }>("/api/me/security/totp/confirm", send("POST", { code })),
    disableTotp: (code: string) => json<SecurityOverview>("/api/me/security/totp", send("DELETE", { code })),
    newRecoveryCodes: (code: string) => json<{ recoveryCodes: string[]; security: SecurityOverview }>("/api/me/security/recovery-codes", send("POST", { code })),
    linkSocial: (provider: SocialProvider) => json<{ url: string }>(`/api/me/security/social/${provider}`, send("POST")),
    unlinkSocial: (provider: SocialProvider) => json<SecurityOverview>(`/api/me/security/social/${provider}`, send("DELETE")),
  },

  admin: {
    users: async () => (await json<{ Resources: ScimUser[] }>("/scim/v2/Users")).Resources,
    createUser: (u: { email: string; firstName: string; lastName: string }) =>
      json<ScimUser>("/scim/v2/Users", send("POST", { userName: u.email, emails: [{ value: u.email, primary: true }], name: { givenName: u.firstName, familyName: u.lastName } })),
    updateUser: (id: string, value: Record<string, unknown>) => json<ScimUser>(scimPath("Users", id), send("PATCH", { schemas: [PATCH_OP], Operations: [{ op: "replace", value }] })),
    deleteUser: (id: string) => request(scimPath("Users", id), send("DELETE")),
    signInLink: async (id: string) => (await json<{ link: string }>(`${scimPath("Users", id)}/signInLink`, send("POST", { purpose: "admin" }))).link,
    resetSecondFactor: (id: string) => request(`${scimPath("Users", id)}/secondFactor`, send("DELETE")),

    groups: async () => (await json<{ Resources: ScimGroup[] }>("/scim/v2/Groups")).Resources,
    createGroup: (name: string) => json<ScimGroup>("/scim/v2/Groups", send("POST", { displayName: name })),
    deleteGroup: (id: string) => request(scimPath("Groups", id), send("DELETE")),
    addMember: (group: string, user: string) =>
      json<ScimGroup>(scimPath("Groups", group), send("PATCH", { schemas: [PATCH_OP], Operations: [{ op: "add", path: "members", value: [{ value: user }] }] })),
    removeMember: (group: string, user: string) =>
      json<ScimGroup>(scimPath("Groups", group), send("PATCH", { schemas: [PATCH_OP], Operations: [{ op: "remove", path: `members[value eq ${JSON.stringify(user)}]` }] })),

    clients: () => json<Client[]>("/api/admin/clients"),
    createClient: (id: string, input: ClientInput) => json<{ client: Client; secret?: string }>("/api/admin/clients", send("POST", { id, ...input })),
    updateClient: (id: string, input: ClientInput) => json<{ client: Client; secret?: string }>(`/api/admin/clients/${encodeURIComponent(id)}`, send("PUT", input)),
    rotateSecret: async (id: string) => (await json<{ secret: string }>(`/api/admin/clients/${encodeURIComponent(id)}/secret`, send("POST"))).secret,
    deleteClient: (id: string) => request(`/api/admin/clients/${encodeURIComponent(id)}`, send("DELETE")),

    tokens: () => json<{ name: string; createdAt: number }[]>("/api/admin/tokens"),
    createToken: async (name: string) => (await json<{ token: string }>("/api/admin/tokens", send("POST", { name }))).token,
    deleteToken: (name: string) => request(`/api/admin/tokens/${encodeURIComponent(name)}`, send("DELETE")),
  },
};
