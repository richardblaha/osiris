import type { Channel, Role } from "@osiris/shared";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import type { Project } from "@osiris/core/projects/project.ts";
import { InternalAuthError, projectAudience, type InternalUser, type InternalVerifier, type VerifiedCall } from "@osiris/platform/internal-auth.ts";

export interface RequestContext {
  project: Project;
  user: InternalUser;
  role: Role;
  channel: Channel;
}

export type AuthEnv = { Variables: { ctx: RequestContext; call: VerifiedCall } };

/** Verifies an internal token for this project from one of `issuers`. */
export async function verifyCall(verifier: InternalVerifier, project: Project, header: string | undefined, issuers: string[]) {
  let call: VerifiedCall;
  try {
    call = await verifier.verifyHeader(header, projectAudience(project.id));
  } catch (err) {
    if (err instanceof InternalAuthError) throw new HTTPException(401, { message: "Unauthorized" });
    throw err;
  }
  if (!issuers.includes(call.issuer)) throw new HTTPException(403, { message: "Not allowed for this caller" });
  return call;
}

/** User calls: the token names the user and their role in this project (checked by the gateway against their claims). */
export function userAuth(verifier: InternalVerifier, project: Project) {
  return createMiddleware<AuthEnv>(async (c, next) => {
    const call = await verifyCall(verifier, project, c.req.header("authorization"), ["gateway", "control"]);
    if (!call.user || !call.role || call.project !== project.id) throw new HTTPException(401, { message: "Unauthorized" });
    c.set("call", call);
    c.set("ctx", { project, user: call.user, role: call.role, channel: call.channel ?? "web" });
    await next();
  });
}

/** The visitor id a public chat's browser makes up for itself. */
export const VISITOR_ID = /^[A-Za-z0-9_-]{16,64}$/;

/**
 * Public calls: the project's customers on its chat page or widget, signed by the gateway with the visitor's id and no
 * user or role. They act as `public:<visitor>` on the `public` channel, which only ever gets the public assistant.
 */
export function publicAuth(verifier: InternalVerifier, project: Project) {
  return createMiddleware<AuthEnv>(async (c, next) => {
    const call = await verifyCall(verifier, project, c.req.header("authorization"), ["gateway"]);
    if (!call.visitor || !VISITOR_ID.test(call.visitor) || call.user || call.project !== project.id) throw new HTTPException(401, { message: "Unauthorized" });
    c.set("call", call);
    const user: InternalUser = { sub: `public:${call.visitor}`, name: null, email: null, phone: null, picture: null };
    c.set("ctx", { project, user, role: "member", channel: "public" });
    await next();
  });
}
