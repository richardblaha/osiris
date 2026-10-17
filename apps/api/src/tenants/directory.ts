import type { DirectoryUser, Role, TenantMember, TenantSummary } from "@osiris/shared";
import { claimList, CLAIMS, isAuthorized, USER_ROLE, type Access } from "../auth/tenants.ts";
import type { UserDirectory, UserRecord } from "../users.ts";
import type { TenantRegistry } from "./registry.ts";

/**
 * Which tenants exist, what they're called and who is in them. A tenant exists when its database does and keeps its
 * name in it (`tenant_settings`); members are the users whose PocketID claims `tenant` / `tenant-admin` name it.
 */
export interface TenantDirectory {
  /** Every tenant, sorted by id. */
  list(): Promise<TenantSummary[]>;
  /** Creates the tenant's database (or brings back an archived one) and names it. */
  create(id: string, name: string): Promise<void>;
  rename(id: string, name: string): Promise<void>;
  /** Removes the tenant from everyone's claims and hides it. The database is archived separately (`TenantRegistry.remove`). */
  remove(id: string): Promise<void>;
  members(id: string): Promise<TenantMember[]>;
  /** Makes the user a member or admin of the tenant, or removes them (`null`). */
  setRole(id: string, userId: string, role: Role | null): Promise<void>;
  /** Users who can be added to a tenant. */
  users(): Promise<DirectoryUser[]>;
}

export class TenantExistsError extends Error {}
export class TenantNotFoundError extends Error {}

/** The user's role in a tenant from their claims; `tenant-admin` wins over `tenant`. */
const roleIn = (user: UserRecord, id: string): Role | null =>
  claimList(user.claims[CLAIMS.tenantAdmin]).includes(id) ? "admin" : claimList(user.claims[CLAIMS.tenant]).includes(id) ? "member" : null;

/** The claim value with `id` added or removed, or null when nothing is left. */
const withTenant = (value: string | undefined, id: string, present: boolean) => {
  const ids = claimList(value).filter((t) => t !== id);
  if (present) ids.push(id);
  return ids.length ? ids.join(",") : null;
};

/** The claims of a user record, as the auth code reads them from a token. */
export const userAccess = (user: UserRecord): Access => ({
  roles: claimList(user.claims[CLAIMS.role]),
  tenants: claimList(user.claims[CLAIMS.tenant]),
  adminTenants: claimList(user.claims[CLAIMS.tenantAdmin]),
});

export function tenantDirectory(tenants: TenantRegistry, users: UserDirectory): TenantDirectory {
  /** Existing tenants; archived ones (kept Turso databases) are left out. */
  const live = async () => {
    const result: { id: string; name: string }[] = [];
    for (const id of await tenants.ids()) {
      const { profile } = await tenants.get(id);
      if (!(await profile.archived())) result.push({ id, name: (await profile.name()) ?? id });
    }
    return result;
  };

  const known = async (id: string) => {
    if (!(await live()).some((t) => t.id === id)) throw new TenantNotFoundError(`Tenant ${id} not found`);
    return tenants.get(id);
  };

  const activeUsers = async () => (await users.list()).filter((u) => !u.disabled);

  return {
    async list() {
      const all = await activeUsers();
      return (await live()).map((t) => ({ ...t, members: all.filter((u) => roleIn(u, t.id)).length }));
    },

    async create(id, name) {
      if ((await live()).some((t) => t.id === id)) throw new TenantExistsError(`Tenant ${id} already exists`);
      // Creates and migrates the database now, so a broken setup shows up here and not on the first login.
      const { profile } = await tenants.get(id);
      await profile.setName(name);
      await profile.setArchived(false);
    },

    async rename(id, name) {
      await (await known(id)).profile.setName(name);
    },

    async remove(id) {
      const { profile } = await known(id);
      for (const user of await users.list()) {
        if (!roleIn(user, id)) continue;
        await users.setClaims(user.id, {
          [CLAIMS.tenant]: withTenant(user.claims[CLAIMS.tenant], id, false),
          [CLAIMS.tenantAdmin]: withTenant(user.claims[CLAIMS.tenantAdmin], id, false),
        });
      }
      await profile.setArchived(true);
    },

    async members(id) {
      await known(id);
      return (await activeUsers())
        .flatMap((u) => {
          const role = roleIn(u, id);
          return role ? [{ userId: u.id, name: u.name, email: u.email, role }] : [];
        })
        .sort((a, b) => (a.name ?? a.email ?? "").localeCompare(b.name ?? b.email ?? ""));
    },

    async setRole(id, userId, role) {
      await known(id);
      const user = (await users.list()).find((u) => u.id === userId);
      const claims = user?.claims ?? {};
      await users.setClaims(userId, {
        // A user is in one of the two claims only.
        [CLAIMS.tenant]: withTenant(claims[CLAIMS.tenant], id, role === "member"),
        [CLAIMS.tenantAdmin]: withTenant(claims[CLAIMS.tenantAdmin], id, role === "admin"),
        // A new member also needs the Osiris role, or the tenant claim alone would get them nowhere.
        ...(role && user && !isAuthorized(userAccess(user)) ? { [CLAIMS.role]: USER_ROLE } : {}),
      });
    },

    async users() {
      return (await activeUsers())
        .map((u) => ({ id: u.id, name: u.name, email: u.email }))
        .sort((a, b) => (a.name ?? a.email ?? "").localeCompare(b.name ?? b.email ?? ""));
    },
  };
}
