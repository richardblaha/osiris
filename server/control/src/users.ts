import { accessFromClaims, accessFromGroups, CLAIMS, groupsFromAccess } from "@osiris/platform/claims.ts";
import { LocalizedError } from "@osiris/platform/i18n.ts";

/**
 * A user as control sees them: profile and the claims that grant access (`role`, `project`, `project-admin`) plus
 * `phone_number`. osiris-auth keeps users and their groups; control reads and changes them over SCIM, and these
 * claims are its groups (`osiris-user`, `project:<slug>`, ...) and phone number in the shape control always used.
 */
export interface UserRecord {
  id: string;
  name: string | null;
  firstName: string;
  lastName: string;
  email: string | null;
  disabled: boolean;
  claims: Record<string, string>;
  /** Public URL of the profile picture, or null. */
  picture: string | null;
}

export interface NewUser {
  email: string | null;
  firstName: string;
  lastName: string;
  claims?: Record<string, string>;
}

export interface ProfileChanges {
  firstName?: string;
  lastName?: string;
  email?: string;
}

/** What a one-time sign-in link is for. */
export type LinkPurpose = "invite" | "admin";

/** The users behind the tokens: project members, roles, profiles and lookup by phone. */
export interface UserDirectory {
  list(): Promise<UserRecord[]>;
  get(userId: string): Promise<UserRecord>;
  findByEmail(email: string): Promise<UserRecord | null>;
  /** Sets (string) or removes (null) claims of a user; other claims are kept. */
  setClaims(userId: string, changes: Record<string, string | null>): Promise<void>;
  create(user: NewUser): Promise<UserRecord>;
  updateProfile(userId: string, changes: ProfileChanges): Promise<UserRecord>;
  setPicture(userId: string, image: Uint8Array, mime: string): Promise<void>;
  /** A disabled user can't sign in, and the gateway refuses their tokens. */
  setDisabled(userId: string, disabled: boolean): Promise<void>;
  /** A one-time sign-in link for the user, e.g. for a new user who has no way to sign in yet. */
  loginLink(userId: string, ttlHours: number, purpose?: LinkPurpose): Promise<string>;
  /** For a user who lost both their authenticator and recovery codes. */
  resetSecondFactor(userId: string): Promise<void>;
}

export class UserNotFoundError extends Error {}
/** The data was refused, e.g. the email is taken; the message can be shown. */
export class UserInputError extends LocalizedError {}

export const PHONE_CLAIM = "phone_number";
const PATCH = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
const PAGE = 1000;

type Resource = {
  id: string;
  name?: { givenName?: string; familyName?: string };
  active?: boolean;
  emails?: { value: string }[];
  phoneNumbers?: { value: string }[];
  photos?: { value: string }[];
  groups?: { value: string }[];
};

const record = (r: Resource): UserRecord & { groups: string[] } => {
  const firstName = r.name?.givenName ?? "";
  const lastName = r.name?.familyName ?? "";
  const groups = (r.groups ?? []).map((g) => g.value);
  const access = accessFromGroups(groups);
  const claims: Record<string, string> = {};
  if (access.roles.length) claims[CLAIMS.role] = access.roles.join(",");
  if (access.projects.length) claims[CLAIMS.project] = access.projects.join(",");
  if (access.adminProjects.length) claims[CLAIMS.projectAdmin] = access.adminProjects.join(",");
  if (r.phoneNumbers?.[0]?.value) claims[PHONE_CLAIM] = r.phoneNumbers[0].value;
  return {
    id: r.id,
    name: `${firstName} ${lastName}`.trim() || null,
    firstName,
    lastName,
    email: r.emails?.[0]?.value ?? null,
    disabled: r.active === false,
    claims,
    picture: r.photos?.[0]?.value ?? null,
    groups,
  };
};

const apply = (claims: Record<string, string>, changes: Record<string, string | null>) => {
  const next = { ...claims };
  for (const [key, value] of Object.entries(changes)) {
    if (value === null || value === "") delete next[key];
    else next[key] = value;
  }
  return next;
};

/** Users in osiris-auth, over SCIM 2.0 with control's service token. */
export function scimUsers(options: { url: string; token: string; fetchFn?: typeof fetch }): UserDirectory {
  const base = `${options.url.replace(/\/$/, "")}/scim/v2`;
  const fetchFn = options.fetchFn ?? fetch;

  const call = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const res = await fetchFn(`${base}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${options.token}`, accept: "application/scim+json", "content-type": "application/scim+json", ...(init.headers as Record<string, string>) },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) return res;
    const detail = ((await res.json().catch(() => ({}))) as { detail?: string }).detail ?? "";
    if (res.status === 404) throw new UserNotFoundError(detail || `Not found: ${path}`);
    if (res.status === 409) throw new UserInputError("errors.user.emailTaken");
    throw new Error(`osiris-auth answered ${res.status} for ${init.method ?? "GET"} ${path}: ${detail}`);
  };
  const json = async <T>(path: string, init?: RequestInit) => (await (await call(path, init)).json()) as T;
  const patch = (path: string, Operations: unknown[]) => call(path, { method: "PATCH", body: JSON.stringify({ schemas: [PATCH], Operations }) });
  const user = async (id: string) => record(await json<Resource>(`/Users/${encodeURIComponent(id)}`));

  const join = async (group: string, userId: string) => {
    const path = `/Groups/${encodeURIComponent(group)}`;
    const add = () => patch(path, [{ op: "add", path: "members", value: [{ value: userId }] }]);
    await add().catch(async (err) => {
      if (!(err instanceof UserNotFoundError)) throw err;
      // A group nobody was in yet; another call may create it at the same time.
      await call("/Groups", { method: "POST", body: JSON.stringify({ displayName: group, members: [{ value: userId }] }) }).catch((e) => (e instanceof UserInputError ? add() : Promise.reject(e)));
    });
  };
  const leave = (group: string, userId: string) =>
    patch(`/Groups/${encodeURIComponent(group)}`, [{ op: "remove", path: `members[value eq ${JSON.stringify(userId)}]` }]).catch((err) => {
      if (!(err instanceof UserNotFoundError)) throw err;
    });

  const directory: UserDirectory = {
    async list() {
      const out: UserRecord[] = [];
      for (let start = 1; ; start += PAGE) {
        const page = await json<{ totalResults: number; Resources?: Resource[] }>(`/Users?startIndex=${start}&count=${PAGE}`);
        out.push(...(page.Resources ?? []).map(record));
        if (!page.Resources?.length || out.length >= page.totalResults) return out;
      }
    },

    get: user,

    async findByEmail(email) {
      const page = await json<{ Resources?: Resource[] }>(`/Users?filter=${encodeURIComponent(`userName eq ${JSON.stringify(email.trim().toLowerCase())}`)}`);
      return page.Resources?.[0] ? record(page.Resources[0]) : null;
    },

    // Two admins changing one user at once can't lose each other's change: each membership is its own add or remove.
    async setClaims(userId, changes) {
      const current = await user(userId);
      const next = apply(current.claims, changes);
      const wanted = groupsFromAccess(accessFromClaims((k) => next[k]));
      for (const g of wanted.filter((g) => !current.groups.includes(g))) await join(g, userId);
      for (const g of current.groups.filter((g) => !wanted.includes(g))) await leave(g, userId);
      if (PHONE_CLAIM in changes && (next[PHONE_CLAIM] ?? null) !== (current.claims[PHONE_CLAIM] ?? null)) {
        await patch(`/Users/${encodeURIComponent(userId)}`, [
          next[PHONE_CLAIM] ? { op: "replace", path: "phoneNumbers", value: [{ value: next[PHONE_CLAIM], type: "mobile" }] } : { op: "remove", path: "phoneNumbers" },
        ]);
      }
    },

    async create(u) {
      const created = record(
        await json<Resource>("/Users", {
          method: "POST",
          body: JSON.stringify({
            schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
            userName: u.email ?? undefined,
            emails: u.email ? [{ value: u.email, primary: true }] : [],
            name: { givenName: u.firstName.trim(), familyName: u.lastName.trim() },
          }),
        }),
      );
      if (u.claims) await directory.setClaims(created.id, u.claims);
      return u.claims ? user(created.id) : created;
    },

    async updateProfile(userId, changes) {
      const name = { ...(changes.firstName !== undefined ? { givenName: changes.firstName.trim() } : {}), ...(changes.lastName !== undefined ? { familyName: changes.lastName.trim() } : {}) };
      const value = {
        ...(Object.keys(name).length ? { name } : {}),
        ...(changes.email !== undefined ? { userName: changes.email, emails: [{ value: changes.email, primary: true }] } : {}),
      };
      return record(await (await patch(`/Users/${encodeURIComponent(userId)}`, [{ op: "replace", value }])).json());
    },

    async setPicture(userId, image, mime) {
      await call(`/Users/${encodeURIComponent(userId)}/photo`, { method: "PUT", body: new Uint8Array(image), headers: { "content-type": mime } });
    },

    async setDisabled(userId, disabled) {
      await patch(`/Users/${encodeURIComponent(userId)}`, [{ op: "replace", path: "active", value: !disabled }]);
    },

    async loginLink(userId, ttlHours, purpose = "admin") {
      return (await json<{ link: string }>(`/Users/${encodeURIComponent(userId)}/signInLink`, { method: "POST", body: JSON.stringify({ ttlHours, purpose }) })).link;
    },

    async resetSecondFactor(userId) {
      await call(`/Users/${encodeURIComponent(userId)}/secondFactor`, { method: "DELETE" });
    },
  };
  return directory;
}
