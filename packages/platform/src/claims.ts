import type { Role } from "@osiris/shared";

export interface Membership {
  projectId: string;
  role: Role;
}

/**
 * The user's claims that grant access (rows of control's `users`). Each takes one value, a comma-separated list or a
 * JSON array: `role=osiris-user`, `project=acme`, `project-admin=acme,beta`.
 */
export const CLAIMS = { role: "role", project: "project", projectAdmin: "project-admin" } as const;

/** Every user of Osiris has one of these roles; without it, the user is refused. */
export const USER_ROLE = "osiris-user";
/** Admin of every project, manages projects. */
export const SYSTEM_ADMIN_ROLE = "osiris-admin";

/** A project slug: lowercase kebab-case. */
export const PROJECT_SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export interface Access {
  roles: string[];
  /** Projects the user is a member of (claim `project`). */
  projects: string[];
  /** Projects the user administers (claim `project-admin`). */
  adminProjects: string[];
}

/** Claim values as a list: a string is split on commas, an array (a JSON claim value) is taken as is. */
export function claimList(value: unknown): string[] {
  const items = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  return [...new Set(items.filter((v): v is string => typeof v === "string").map((v) => v.trim()).filter(Boolean))];
}

export const accessFromClaims = (claim: (key: string) => unknown): Access => ({
  roles: claimList(claim(CLAIMS.role)),
  projects: claimList(claim(CLAIMS.project)),
  adminProjects: claimList(claim(CLAIMS.projectAdmin)),
});

/**
 * The same access as osiris-auth's groups: `osiris-user`, `osiris-admin`, `project:<slug>` and `project-admin:<slug>`.
 * Tokens carry them in the `groups` claim; control turns its claim changes into memberships of these groups.
 */
export const groupsFromAccess = (access: Access): string[] => [
  ...access.roles.filter((r) => r === USER_ROLE || r === SYSTEM_ADMIN_ROLE),
  ...access.projects.map((p) => `project:${p}`),
  ...access.adminProjects.map((p) => `project-admin:${p}`),
];

export const accessFromGroups = (groups: unknown): Access => {
  const list = claimList(groups);
  const after = (prefix: string) => list.flatMap((g) => (g.startsWith(prefix) ? [g.slice(prefix.length)] : []));
  return { roles: list.filter((g) => g === USER_ROLE || g === SYSTEM_ADMIN_ROLE), projects: after("project:"), adminProjects: after("project-admin:") };
};

export const isSystemAdmin = (access: Access) => access.roles.includes(SYSTEM_ADMIN_ROLE);
export const isAuthorized = (access: Access) => access.roles.includes(USER_ROLE) || isSystemAdmin(access);

/**
 * Project memberships from the claims: `project-admin` makes the user an admin, `project` a member (no need for both).
 * Values that aren't valid slugs are ignored.
 */
export function membershipsFromClaims(access: Access): Membership[] {
  const roles = new Map<string, Role>();
  for (const id of access.projects) if (PROJECT_SLUG.test(id)) roles.set(id, "member");
  for (const id of access.adminProjects) if (PROJECT_SLUG.test(id)) roles.set(id, "admin");
  return [...roles].map(([projectId, role]) => ({ projectId, role })).sort((a, b) => a.projectId.localeCompare(b.projectId));
}

/**
 * The projects a user can open: none without an Osiris role, every project (as admin) for a system admin,
 * otherwise those in their claims.
 */
export function accessibleProjects(access: Access, allProjects: string[]): Membership[] {
  if (!isAuthorized(access)) return [];
  if (!isSystemAdmin(access)) return membershipsFromClaims(access);
  return allProjects.map((projectId) => ({ projectId, role: "admin" as const }));
}
