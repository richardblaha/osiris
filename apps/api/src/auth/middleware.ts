import type { Role } from "@osiris/shared";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import type { Tenant } from "../tenants/tenant.ts";
import type { TenantRegistry } from "../tenants/registry.ts";
import type { Identity, TokenVerifier } from "./oidc.ts";
import { membershipsFromGroups, type Membership } from "./tenants.ts";

export interface Authenticated {
  user: Identity;
  memberships: Membership[];
}

export interface RequestContext extends Authenticated {
  tenant: Tenant;
  role: Role;
}

export type AuthEnv = { Variables: { auth: Authenticated; ctx: RequestContext } };

/** Authenticates the bearer token. Memberships come from the user's PocketID groups; users with none are refused. */
export function authMiddleware(verifier: TokenVerifier) {
  return createMiddleware<AuthEnv>(async (c, next) => {
    const token = c.req.header("authorization")?.match(/^Bearer (.+)$/i)?.[1];
    if (!token) throw new HTTPException(401, { message: "Missing bearer token" });

    let user: Identity;
    try {
      user = await verifier.identify(token);
    } catch {
      throw new HTTPException(401, { message: "Invalid token" });
    }

    const memberships = membershipsFromGroups(user.groups);
    if (!memberships.length) throw new HTTPException(403, { message: "User is not assigned to any tenant" });
    c.set("auth", { user, memberships });
    await next();
  });
}

/**
 * Opens the active tenant. It comes from the `X-Tenant-Id` header and must be one of the user's memberships;
 * without the header, the user's only tenant is used.
 */
export function tenantMiddleware(tenants: TenantRegistry) {
  return createMiddleware<AuthEnv>(async (c, next) => {
    const { user, memberships } = c.get("auth");
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

    c.set("ctx", { user, memberships, tenant: await tenants.get(membership.tenantId), role: membership.role });
    await next();
  });
}
