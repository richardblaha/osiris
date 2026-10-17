import type { Role } from "@osiris/shared";
import type { TenantDirectory } from "../tenants/directory.ts";

export interface Membership {
  tenantId: string;
  role: Role;
}

/** PocketID group whose members are admins of every tenant and manage tenants. */
export const SYSTEM_ADMIN_GROUP = "osiris-admin";

const GROUP = /^osiris-tenant-([a-z0-9]+(?:-[a-z0-9]+)*)-(admin|user)$/;

/** A tenant slug: lowercase kebab-case, not ending in `-admin` or `-user` (those suffixes mark the groups). */
export const TENANT_SLUG = /^(?!.*-(admin|user)$)[a-z0-9]+(-[a-z0-9]+)*$/;

export const tenantGroup = (tenantId: string, role: Role) => `osiris-tenant-${tenantId}-${role === "admin" ? "admin" : "user"}`;

/** Parses a tenant group name: `osiris-tenant-<slug>-user` (member) or `osiris-tenant-<slug>-admin` (admin). */
export function parseTenantGroup(group: string): Membership | null {
  const m = GROUP.exec(group);
  return m ? { tenantId: m[1]!, role: m[2] === "admin" ? "admin" : "member" } : null;
}

export const isSystemAdmin = (groups: readonly string[]) => groups.includes(SYSTEM_ADMIN_GROUP);

/**
 * Derives tenant memberships from PocketID group names:
 * `osiris-tenant-<slug>-user` makes the user a member, `osiris-tenant-<slug>-admin` an admin (no need to be in both).
 * Other groups are ignored.
 */
export function membershipsFromGroups(groups: readonly string[]): Membership[] {
  const roles = new Map<string, Role>();
  for (const group of groups) {
    const m = parseTenantGroup(group);
    if (m && (m.role === "admin" || !roles.has(m.tenantId))) roles.set(m.tenantId, m.role);
  }
  return [...roles].map(([tenantId, role]) => ({ tenantId, role })).sort((a, b) => a.tenantId.localeCompare(b.tenantId));
}

/** The tenants a user can open: from their groups, or every tenant (as admin) for a system admin. */
export async function accessibleTenants(groups: readonly string[], directory: TenantDirectory): Promise<Membership[]> {
  if (!isSystemAdmin(groups)) return membershipsFromGroups(groups);
  return (await directory.list()).map((t) => ({ tenantId: t.id, role: "admin" as const }));
}
