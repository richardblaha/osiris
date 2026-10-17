import { displayName, type PocketIdClient, type PocketIdUser } from "./pocketid.ts";

/** A PocketID user with their custom claims (`phone_number`, `role`, `tenant`, `tenant-admin`, ...). */
export interface UserRecord {
  id: string;
  name: string | null;
  email: string | null;
  disabled: boolean;
  claims: Record<string, string>;
}

/** The users behind the tokens, for what OIDC doesn't cover: tenant members, roles and lookup by phone. */
export interface UserDirectory {
  /** Every user. Cached briefly; `setClaims` refreshes it. */
  list(): Promise<UserRecord[]>;
  /** Sets (string) or removes (null) custom claims of a user; other claims are kept. */
  setClaims(userId: string, changes: Record<string, string | null>): Promise<void>;
}

export class UserNotFoundError extends Error {}

/** How long the user list is reused, so new users, numbers and claim changes apply within this time. */
const LIST_TTL_MS = 60_000;

const record = (u: PocketIdUser): UserRecord => ({
  id: u.id,
  name: displayName(u),
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

/** Users from the PocketID admin API (`GET /api/users`); claims are written with `PUT /api/custom-claims/user/:id`. */
export function pocketIdUsers(pocketId: PocketIdClient): UserDirectory {
  let cache: { at: number; users: Promise<UserRecord[]> } | undefined;
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

    async setClaims(userId, changes) {
      const id = encodeURIComponent(userId);
      // The PUT replaces all of the user's claims, so start from their current ones rather than the cached list.
      const current = await pocketId.get<PocketIdUser>(`api/users/${id}`).catch((err) => {
        if (err?.status === 404) throw new UserNotFoundError(`User ${userId} not found`);
        throw err;
      });
      const claims = apply(record(current).claims, changes);
      try {
        await pocketId.request("PUT", `api/custom-claims/user/${id}`, Object.entries(claims).map(([key, value]) => ({ key, value })));
      } finally {
        cache = undefined;
      }
    },
  };
}

/** Users kept in memory, for development without a PocketID API key and for tests. Lost on restart. */
export function memoryUsers(initial: UserRecord[] = []): UserDirectory & { users: UserRecord[] } {
  const users = initial.map((u) => ({ ...u, claims: { ...u.claims } }));
  return {
    users,
    async list() {
      return users;
    },
    async setClaims(userId, changes) {
      const user = users.find((u) => u.id === userId);
      if (!user) throw new UserNotFoundError(`User ${userId} not found`);
      user.claims = apply(user.claims, changes);
    },
  };
}
