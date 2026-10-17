import type { Role } from "@osiris/shared";
import type { TenantDirectory } from "../tenants/directory.ts";

export interface Membership {
  tenantId: string;
  role: Role;
}

/**
 * PocketID custom claims that grant access, set on the user. Each takes one value or a comma-separated list
 * (PocketID stores one string per claim): `role=osiris-user`, `tenant=acme`, `tenant-admin=acme,beta`.
 */
export const CLAIMS = { role: "role", tenant: "tenant", tenantAdmin: "tenant-admin" } as const;

/** Every user of Osiris has one of these roles; without it, the user is refused. */
export const USER_ROLE = "osiris-user";
/** Admin of every tenant, manages tenants. */
export const SYSTEM_ADMIN_ROLE = "osiris-admin";

/** A tenant slug: lowercase kebab-case. */
export const TENANT_SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export interface Access {
  roles: string[];
  /** Tenants the user is a member of (claim `tenant`). */
  tenants: string[];
  /** Tenants the user administers (claim `tenant-admin`). */
  adminTenants: string[];
}

/** Claim values as a list: a string is split on commas, an array (a JSON claim value) is taken as is. */
export function claimList(value: unknown): string[] {
  const items = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  return [...new Set(items.filter((v): v is string => typeof v === "string").map((v) => v.trim()).filter(Boolean))];
}

export const accessFromClaims = (claim: (key: string) => unknown): Access => ({
  roles: claimList(claim(CLAIMS.role)),
  tenants: claimList(claim(CLAIMS.tenant)),
  adminTenants: claimList(claim(CLAIMS.tenantAdmin)),
});

export const isSystemAdmin = (access: Access) => access.roles.includes(SYSTEM_ADMIN_ROLE);
export const isAuthorized = (access: Access) => access.roles.includes(USER_ROLE) || isSystemAdmin(access);

/**
 * Tenant memberships from the claims: `tenant-admin` makes the user an admin, `tenant` a member (no need for both).
 * Values that aren't valid slugs are ignored.
 */
export function membershipsFromClaims(access: Access): Membership[] {
  const roles = new Map<string, Role>();
  for (const id of access.tenants) if (TENANT_SLUG.test(id)) roles.set(id, "member");
  for (const id of access.adminTenants) if (TENANT_SLUG.test(id)) roles.set(id, "admin");
  return [...roles].map(([tenantId, role]) => ({ tenantId, role })).sort((a, b) => a.tenantId.localeCompare(b.tenantId));
}

/**
 * The tenants a user can open: none without an Osiris role, every tenant (as admin) for a system admin,
 * otherwise those in their claims.
 */
export async function accessibleTenants(access: Access, directory: TenantDirectory): Promise<Membership[]> {
  if (!isAuthorized(access)) return [];
  if (!isSystemAdmin(access)) return membershipsFromClaims(access);
  return (await directory.list()).map((t) => ({ tenantId: t.id, role: "admin" as const }));
}
