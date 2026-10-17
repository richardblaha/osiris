import { randomUUID } from "node:crypto";
import { displayName, PocketIdError, type PocketIdClient, type PocketIdUser } from "./pocketid.ts";

/** A PocketID user with their custom claims (`phone_number`, `role`, `tenant`, `tenant-admin`, ...). */
export interface UserRecord {
  id: string;
  username: string;
  name: string | null;
  firstName: string;
  lastName: string;
  email: string | null;
  disabled: boolean;
  claims: Record<string, string>;
}

export interface NewUser {
  username: string;
  email: string;
  firstName: string;
  lastName: string;
}

export interface ProfileChanges {
  firstName?: string;
  lastName?: string;
  email?: string;
}

/** The users behind the tokens: tenant members, roles, profiles and lookup by phone. Only control has it. */
export interface UserDirectory {
  /** Every user. Cached briefly; writes refresh it. */
  list(): Promise<UserRecord[]>;
  /** One user, read fresh. */
  get(userId: string): Promise<UserRecord>;
  /** Sets (string) or removes (null) custom claims of a user; other claims are kept. */
  setClaims(userId: string, changes: Record<string, string | null>): Promise<void>;
  create(user: NewUser): Promise<UserRecord>;
  updateProfile(userId: string, changes: ProfileChanges): Promise<UserRecord>;
  setPicture(userId: string, image: Uint8Array, mime: string): Promise<void>;
  /** A one-time sign-in link for the user (new users have no passkey yet). */
  loginLink(userId: string, ttlHours: number): Promise<string>;
}

export class UserNotFoundError extends Error {}
/** PocketID refused the data, e.g. the username or email is taken; the message can be shown. */
export class UserInputError extends Error {}

/** How long the user list is reused, so new users, numbers and claim changes apply within this time. */
const LIST_TTL_MS = 60_000;

const record = (u: PocketIdUser): UserRecord => ({
  id: u.id,
  username: u.username ?? "",
  name: displayName(u),
  firstName: u.firstName ?? "",
  lastName: u.lastName ?? "",
  email: u.email || null,
  disabled: !!u.disabled,
  claims: Object.fromEntries((u.customClaims ?? []).map((c) => [c.key, c.value])),
});

const apply = (claims: Record<string, string>, changes: Record<string, string | null>) => {
  const next = { ...claims };
  for (const [key, value] of Object.entries(changes)) {
    if (value === null || value === "") delete next[key];
    else next[key] = value;
  }
  return next;
};

/** Users from the PocketID admin API; claims are written with `PUT /api/custom-claims/user/:id`. */
export function pocketIdUsers(pocketId: PocketIdClient, issuer: string): UserDirectory {
  let cache: { at: number; users: Promise<UserRecord[]> } | undefined;
  const fetchUser = (userId: string) =>
    pocketId.get<PocketIdUser>(`api/users/${encodeURIComponent(userId)}`).catch((err) => {
      if (err instanceof PocketIdError && err.status === 404) throw new UserNotFoundError(`User ${userId} not found`);
      throw err;
    });
  const inputErrors = async <T>(action: () => Promise<T>) => {
    try {
      return await action();
    } catch (err) {
      if (err instanceof PocketIdError && err.status >= 400 && err.status < 500 && err.status !== 401 && err.status !== 403) {
        throw new UserInputError(err.detail ?? "PocketID odmítl údaje uživatele");
      }
      throw err;
    } finally {
      cache = undefined;
    }
  };

  return {
    list() {
      if (!cache || Date.now() - cache.at > LIST_TTL_MS) {
        const loading = pocketId.all<PocketIdUser>("api/users").then((users) => users.map(record));
        // Don't cache failures; the next call retries.
        loading.catch(() => {
          if (cache?.users === loading) cache = undefined;
        });
        cache = { at: Date.now(), users: loading };
      }
      return cache.users;
    },

    async get(userId) {
      return record(await fetchUser(userId));
    },

    async setClaims(userId, changes) {
      // The PUT replaces all of the user's claims, so start from their current ones rather than the cached list.
      const claims = apply(record(await fetchUser(userId)).claims, changes);
      try {
        await pocketId.request("PUT", `api/custom-claims/user/${encodeURIComponent(userId)}`, Object.entries(claims).map(([key, value]) => ({ key, value })));
      } finally {
        cache = undefined;
      }
    },

    create(user) {
      return inputErrors(async () =>
        record(
          await pocketId.request<PocketIdUser>("POST", "api/users", {
            username: user.username,
            email: user.email,
            firstName: user.firstName,
            lastName: user.lastName,
            displayName: `${user.firstName} ${user.lastName}`.trim(),
            isAdmin: false,
            disabled: false,
          }),
        ),
      );
    },

    updateProfile(userId, changes) {
      return inputErrors(async () => {
        // The PUT takes the whole user, so unchanged fields are sent back as they are.
        const u = await fetchUser(userId);
        const firstName = changes.firstName ?? u.firstName ?? "";
        const lastName = changes.lastName ?? u.lastName ?? "";
        const emailChanged = changes.email !== undefined && changes.email !== u.email;
        return record(
          await pocketId.request<PocketIdUser>("PUT", `api/users/${encodeURIComponent(userId)}`, {
            username: u.username,
            email: changes.email ?? u.email,
            emailVerified: emailChanged ? false : !!u.emailVerified,
            firstName,
            lastName,
            displayName: `${firstName} ${lastName}`.trim() || u.displayName,
            isAdmin: !!u.isAdmin,
            locale: u.locale ?? null,
            disabled: !!u.disabled,
          }),
        );
      });
    },

    setPicture(userId, image, mime) {
      return inputErrors(async () => {
        const form = new FormData();
        form.append("file", new Blob([new Uint8Array(image)], { type: mime }), mime === "image/png" ? "picture.png" : "picture.jpg");
        await pocketId.request("PUT", `api/users/${encodeURIComponent(userId)}/profile-picture`, form);
      });
    },

    async loginLink(userId, ttlHours) {
      const { token } = await pocketId.request<{ token: string }>("POST", `api/users/${encodeURIComponent(userId)}/one-time-access-token`, {
        ttl: `${ttlHours}h`,
      });
      return new URL(`lc/${encodeURIComponent(token)}`, issuer.endsWith("/") ? issuer : `${issuer}/`).toString();
    },
  };
}

/** Users kept in memory, for development without a PocketID API key and for tests. Lost on restart. */
export function memoryUsers(initial: Partial<UserRecord>[] = []): UserDirectory & { users: UserRecord[] } {
  const full = (u: Partial<UserRecord>): UserRecord => ({
    id: u.id ?? randomUUID(),
    username: u.username ?? u.id ?? "",
    name: u.name ?? null,
    firstName: u.firstName ?? "",
    lastName: u.lastName ?? "",
    email: u.email ?? null,
    disabled: u.disabled ?? false,
    claims: { ...u.claims },
  });
  const users = initial.map(full);
  const find = (userId: string) => {
    const user = users.find((u) => u.id === userId);
    if (!user) throw new UserNotFoundError(`User ${userId} not found`);
    return user;
  };
  return {
    users,
    async list() {
      return users;
    },
    async get(userId) {
      return find(userId);
    },
    async setClaims(userId, changes) {
      const user = find(userId);
      user.claims = apply(user.claims, changes);
    },
    async create(user) {
      if (users.some((u) => u.username === user.username || (u.email && u.email === user.email))) {
        throw new UserInputError("Uživatel s tímto jménem nebo e-mailem už existuje");
      }
      const created = full({ ...user, name: `${user.firstName} ${user.lastName}`.trim() });
      users.push(created);
      return created;
    },
    async updateProfile(userId, changes) {
      const user = find(userId);
      Object.assign(user, Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined)));
      user.name = `${user.firstName} ${user.lastName}`.trim() || user.name;
      return user;
    },
    async setPicture(userId) {
      find(userId);
    },
    async loginLink(userId) {
      find(userId);
      return `http://localhost/lc/dev-${userId}`;
    },
  };
}
