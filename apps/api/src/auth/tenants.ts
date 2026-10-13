import type { Role } from "@osiris/shared";

export interface Membership {
  tenantId: string;
  role: Role;
}

const GROUP = /^tenant-([a-z0-9]+(?:-[a-z0-9]+)*?)(-admin)?$/;

/**
 * Derives tenant memberships from PocketID group names:
 * `tenant-<slug>` makes the user a member, `tenant-<slug>-admin` an admin (no need to be in both).
 * Because of this, a slug can't end in `-admin`. Other groups are ignored.
 */
export function membershipsFromGroups(groups: readonly string[]): Membership[] {
  const roles = new Map<string, Role>();
  for (const group of groups) {
    const m = GROUP.exec(group);
    if (!m) continue;
    const tenantId = m[1]!;
    if (m[2] || !roles.has(tenantId)) roles.set(tenantId, m[2] ? "admin" : "member");
  }
  return [...roles].map(([tenantId, role]) => ({ tenantId, role })).sort((a, b) => a.tenantId.localeCompare(b.tenantId));
}
