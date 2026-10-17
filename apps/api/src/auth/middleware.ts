import type { Role } from "@osiris/shared";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import type { Tenant } from "../tenants/tenant.ts";
import type { TenantDirectory } from "../tenants/directory.ts";
import type { TenantRegistry } from "../tenants/registry.ts";
import type { Identity, TokenVerifier } from "./oidc.ts";
import { accessibleTenants, isAuthorized, isSystemAdmin, type Membership } from "./tenants.ts";

export interface Authenticated {
  user: Identity;
  memberships: Membership[];
  /** Claim `role=osiris-admin`: admin of every tenant, may manage tenants. */
  systemAdmin: boolean;
}

export interface RequestContext extends Authenticated {
  tenant: Tenant;
  role: Role;
}

/** A 403 that tells the user who they are signed in as and which claims arrived, so a misconfigured account is easy to fix. */
export class AccessDeniedError extends HTTPException {
  constructor(
    message: string,
    readonly user: Record<string, unknown>,
  ) {
    super(403, { message });
  }
}

const describeUser = (user: Identity) => ({
  sub: user.sub,
  name: user.name,
  email: user.email,
  role: user.access.roles,
  tenant: user.access.tenants,
  "tenant-admin": user.access.adminTenants,
  ...(user.claimKeys ? { claims: user.claimKeys } : {}),
});

export type AuthEnv = { Variables: { auth: Authenticated; ctx: RequestContext } };

/**
 * Authenticates the bearer token. Users need the claim `role` (`osiris-user` or `osiris-admin`); memberships come from
 * the claims `tenant` and `tenant-admin` (a system admin gets every tenant). Users with no tenant are refused, except
 * system admins, who may have no tenant yet.
 */
export function authMiddleware(verifier: TokenVerifier, directory: TenantDirectory) {
  return createMiddleware<AuthEnv>(async (c, next) => {
    const token = c.req.header("authorization")?.match(/^Bearer (.+)$/i)?.[1];
    if (!token) throw new HTTPException(401, { message: "Missing bearer token" });

    let user: Identity;
    try {
      user = await verifier.identify(token);
    } catch {
      throw new HTTPException(401, { message: "Invalid token" });
    }

    const deny = (message: string) => {
      const details = describeUser(user);
      console.warn(`Access denied: ${message}`, details);
      return new AccessDeniedError(message, details);
    };
    if (!isAuthorized(user.access)) throw deny("User has no Osiris role (claim role=osiris-user or osiris-admin)");
    const systemAdmin = isSystemAdmin(user.access);
    const memberships = await accessibleTenants(user.access, directory);
    if (!memberships.length && !systemAdmin) throw deny("User is not assigned to any tenant (claim tenant or tenant-admin)");
    c.set("auth", { user, memberships, systemAdmin });
    await next();
  });
}

/**
 * Opens the active tenant. It comes from the `X-Tenant-Id` header and must be one of the user's memberships;
 * without the header, the user's only tenant is used.
 */
export function tenantMiddleware(tenants: TenantRegistry) {
  return createMiddleware<AuthEnv>(async (c, next) => {
    const { memberships } = c.get("auth");
    const requested = c.req.header("x-tenant-id");
    const membership = requested
      ? memberships.find((m) => m.tenantId === requested)
      : memberships.length === 1
        ? memberships[0]
        : undefined;

    if (!membership) {
      throw new HTTPException(requested ? 403 : 400, {
        message: requested ? "Not a member of this tenant" : "X-Tenant-Id header required",
      });
    }

    const tenant = await tenants.get(membership.tenantId);
    // A removed tenant whose database is kept (Turso) stays closed, even for a claim that wasn't cleaned up.
    if (await tenant.profile.archived()) throw new HTTPException(403, { message: "Tenant was removed" });
    c.set("ctx", { ...c.get("auth"), tenant, role: membership.role });
    await next();
  });
}
