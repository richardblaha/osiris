import type { DirectoryUser, Role, TenantMember, TenantSummary } from "@osiris/shared";
import { parseTenantGroup, tenantGroup } from "../auth/tenants.ts";
import { displayName, type PocketIdClient, type PocketIdGroup, type PocketIdUser } from "../pocketid.ts";

/**
 * Which tenants exist, what they're called and who is in them. In production these are PocketID groups
 * (`osiris-tenant-<slug>` and `osiris-tenant-<slug>-admin`), so there is still no global database.
 */
export interface TenantDirectory {
  /** Every tenant, sorted by id. Cached briefly; writes refresh it. */
  list(): Promise<TenantSummary[]>;
  create(id: string, name: string): Promise<void>;
  rename(id: string, name: string): Promise<void>;
  /** Removes the tenant's groups and with them everyone's access. Its database is archived separately. */
  remove(id: string): Promise<void>;
  members(id: string): Promise<TenantMember[]>;
  /** Makes the user a member or admin of the tenant, or removes them (`null`). */
  setRole(id: string, userId: string, role: Role | null): Promise<void>;
  /** Users who can be added to a tenant. */
  users(): Promise<DirectoryUser[]>;
}

export class TenantExistsError extends Error {}
export class TenantNotFoundError extends Error {}

const LIST_TTL_MS = 60_000;
const PREFIX = "Osiris: ";
const ADMIN_SUFFIX = " (správci)";

/** Tenants as PocketID groups. Display names live in the groups' friendly names ("Osiris: <name>"). */
export function pocketIdTenants(pocketId: PocketIdClient): TenantDirectory {
  let cache: { at: number; groups: Promise<PocketIdGroup[]> } | undefined;

  const groups = () => {
    if (!cache || Date.now() - cache.at > LIST_TTL_MS) {
      const loading = pocketId.all<PocketIdGroup>("api/user-groups");
      loading.catch(() => {
        if (cache?.groups === loading) cache = undefined;
      });
      cache = { at: Date.now(), groups: loading };
    }
    return cache.groups;
  };

  /** The tenant's member and admin group; at least one exists for a known tenant. */
  const tenantGroups = async (id: string) => {
    const all = await groups();
    const find = (role: Role) => all.find((g) => g.name === tenantGroup(id, role));
    const result = { member: find("member"), admin: find("admin") };
    if (!result.member && !result.admin) throw new TenantNotFoundError(`Tenant ${id} not found`);
    return result;
  };

  const friendly = (name: string, role: Role) => `${PREFIX}${name}${role === "admin" ? ADMIN_SUFFIX : ""}`;
  const nameOf = (g: PocketIdGroup) => g.friendlyName.replace(PREFIX, "").replace(ADMIN_SUFFIX, "").trim();

  const createGroup = (id: string, name: string, role: Role) =>
    pocketId.request<PocketIdGroup>("POST", "api/user-groups", { name: tenantGroup(id, role), friendlyName: friendly(name, role) });

  const groupUsers = async (group: PocketIdGroup | undefined) =>
    group ? ((await pocketId.get<PocketIdGroup>(`api/user-groups/${group.id}`)).users ?? []) : [];

  const setGroupUsers = (group: PocketIdGroup, userIds: string[]) =>
    pocketId.request("PUT", `api/user-groups/${group.id}/users`, { userIds });

  return {
    async list() {
      const byId = new Map<string, TenantSummary>();
      for (const g of await groups()) {
        const m = parseTenantGroup(g.name);
        if (!m) continue;
        const t = byId.get(m.tenantId) ?? { id: m.tenantId, name: m.tenantId, members: 0 };
        // The member group's name wins; an admin-only tenant (created by hand) takes the admin group's.
        if (m.role === "member" || t.name === t.id) t.name = nameOf(g) || t.id;
        t.members += g.userCount ?? 0;
        byId.set(m.tenantId, t);
      }
      return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
    },

    async create(id, name) {
      const all = await groups();
      if (all.some((g) => parseTenantGroup(g.name)?.tenantId === id)) throw new TenantExistsError(`Tenant ${id} already exists`);
      try {
        await createGroup(id, name, "member");
        await createGroup(id, name, "admin");
      } finally {
        cache = undefined;
      }
    },

    async rename(id, name) {
      const { member, admin } = await tenantGroups(id);
      try {
        // An admin-only tenant gets its member group now.
        if (member) await pocketId.request("PUT", `api/user-groups/${member.id}`, { name: member.name, friendlyName: friendly(name, "member") });
        else await createGroup(id, name, "member");
        if (admin) await pocketId.request("PUT", `api/user-groups/${admin.id}`, { name: admin.name, friendlyName: friendly(name, "admin") });
        else await createGroup(id, name, "admin");
      } finally {
        cache = undefined;
      }
    },

    async remove(id) {
      const { member, admin } = await tenantGroups(id);
      try {
        for (const g of [member, admin]) if (g) await pocketId.request("DELETE", `api/user-groups/${g.id}`);
      } finally {
        cache = undefined;
      }
    },

    async members(id) {
      const { member, admin } = await tenantGroups(id);
      const byId = new Map<string, TenantMember>();
      for (const [group, role] of [[member, "member"], [admin, "admin"]] as const) {
        for (const u of await groupUsers(group)) {
          if (role === "admin" || !byId.has(u.id)) byId.set(u.id, { userId: u.id, name: displayName(u), email: u.email || null, role });
        }
      }
      return [...byId.values()].sort((a, b) => (a.name ?? a.email ?? "").localeCompare(b.name ?? b.email ?? ""));
    },

    async setRole(id, userId, role) {
      let { member, admin } = await tenantGroups(id);
      try {
        // Missing groups are created on demand (e.g. an admin-only tenant gets its first plain member).
        const name = nameOf((member ?? admin)!);
        if (role === "member" && !member) member = await createGroup(id, name, "member");
        if (role === "admin" && !admin) admin = await createGroup(id, name, "admin");
        // An admin is in the admin group only, a member in the member group only.
        for (const [group, groupRole] of [[member, "member"], [admin, "admin"]] as const) {
          if (!group) continue;
          const ids = (await groupUsers(group)).map((u) => u.id);
          const want = role === groupRole;
          if (want !== ids.includes(userId)) await setGroupUsers(group, want ? [...ids, userId] : ids.filter((u) => u !== userId));
        }
      } finally {
        cache = undefined;
      }
    },

    async users() {
      const users = await pocketId.all<PocketIdUser>("api/users");
      return users
        .filter((u) => !u.disabled)
        .map((u) => ({ id: u.id, name: displayName(u), email: u.email || null }))
        .sort((a, b) => (a.name ?? a.email ?? "").localeCompare(b.name ?? b.email ?? ""));
    },
  };
}

/**
 * In-memory directory for development without a PocketID API key, and for tests. Memberships still come from
 * the (dev) token's groups; the members kept here are only for the admin UI and are lost on restart.
 */
export function memoryTenants(initial: { id: string; name?: string }[] = [], users: DirectoryUser[] = []): TenantDirectory {
  const tenants = new Map(initial.map((t) => [t.id, { name: t.name ?? t.id, members: new Map<string, Role>() }]));
  const get = (id: string) => {
    const t = tenants.get(id);
    if (!t) throw new TenantNotFoundError(`Tenant ${id} not found`);
    return t;
  };
  return {
    async list() {
      return [...tenants]
        .map(([id, t]) => ({ id, name: t.name, members: t.members.size }))
        .sort((a, b) => a.id.localeCompare(b.id));
    },
    async create(id, name) {
      if (tenants.has(id)) throw new TenantExistsError(`Tenant ${id} already exists`);
      tenants.set(id, { name, members: new Map() });
    },
    async rename(id, name) {
      get(id).name = name;
    },
    async remove(id) {
      get(id);
      tenants.delete(id);
    },
    async members(id) {
      return [...get(id).members].map(([userId, role]) => {
        const u = users.find((x) => x.id === userId);
        return { userId, name: u?.name ?? null, email: u?.email ?? null, role };
      });
    },
    async setRole(id, userId, role) {
      const t = get(id);
      if (role) t.members.set(userId, role);
      else t.members.delete(userId);
    },
    async users() {
      return users;
    },
  };
}
