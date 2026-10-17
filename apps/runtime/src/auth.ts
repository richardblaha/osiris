import type { Channel, Role } from "@osiris/shared";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import type { Tenant } from "@osiris/core/tenants/tenant.ts";
import { InternalAuthError, tenantAudience, type InternalUser, type InternalVerifier, type VerifiedCall } from "@osiris/platform/internal-auth.ts";

export interface RequestContext {
  tenant: Tenant;
  user: InternalUser;
  role: Role;
  channel: Channel;
}

export type AuthEnv = { Variables: { ctx: RequestContext; call: VerifiedCall } };

/** Verifies an internal token for this tenant from one of `issuers`. */
export async function verifyCall(verifier: InternalVerifier, tenant: Tenant, header: string | undefined, issuers: string[]) {
  let call: VerifiedCall;
  try {
    call = await verifier.verifyHeader(header, tenantAudience(tenant.id));
  } catch (err) {
    if (err instanceof InternalAuthError) throw new HTTPException(401, { message: "Unauthorized" });
    throw err;
  }
  if (!issuers.includes(call.issuer)) throw new HTTPException(403, { message: "Not allowed for this caller" });
  return call;
}

/** User calls: the token names the user and their role in this tenant (checked by the gateway against their claims). */
export function userAuth(verifier: InternalVerifier, tenant: Tenant) {
  return createMiddleware<AuthEnv>(async (c, next) => {
    const call = await verifyCall(verifier, tenant, c.req.header("authorization"), ["gateway", "control"]);
    if (!call.user || !call.role || call.tenant !== tenant.id) throw new HTTPException(401, { message: "Unauthorized" });
    c.set("call", call);
    c.set("ctx", { tenant, user: call.user, role: call.role, channel: call.channel ?? "web" });
    await next();
  });
}
