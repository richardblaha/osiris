import { readAll } from "@osiris/platform/objects.ts";
import { Readable } from "node:stream";
import {
  FEATURES,
  GUARD_NAME,
  type Guard,
  type SystemDefaults,
  type AdminUser,
  type InviteResult,
  type MeResponse,
  type Role,
  type Schedule,
  type SiteDomain,
  type SiteRelease,
  type TenantDetail,
  type TenantFeatures,
  type TenantInfo,
  type TenantMember,
  type TenantSummary,
  type UserProfile,
} from "@osiris/shared";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { CLAIMS, claimList, SYSTEM_ADMIN_ROLE, TENANT_SLUG, USER_ROLE } from "@osiris/platform/claims.ts";
import { CONTROL_AUDIENCE, InternalAuthError, type InternalVerifier, type VerifiedCall } from "@osiris/platform/internal-auth.ts";
import { RuntimeIdentityError, type RuntimeIdentityVerifier } from "@osiris/platform/runtime-identity.ts";
import { CredentialError } from "./auth/credentials.ts";
import { WEB_CLIENT_ID } from "./auth/oidc.ts";
import { authRoutes, securityRoutes, type AuthDeps } from "./auth/routes.ts";
import { SocialLoginError } from "./auth/social.ts";
import type { Backups } from "./backups.ts";
import type { Orchestrator } from "./orchestrator/types.ts";
import { ScheduleError, ScheduleNotFoundError, type ScheduleStore } from "./scheduler.ts";
import { DomainError, type DomainStore } from "./sites/domains.ts";
import { PublishError, SITE_LIMITS, type SitePublisher } from "./sites/publisher.ts";
import { QuotaError, TenantExistsError, TenantNotFoundError, type TenantDirectory, type TenantRow } from "./tenants.ts";
import { UserInputError, UserNotFoundError, type UserDirectory } from "./users.ts";
import { PHONE_CLAIM, type PhoneVerification } from "./whatsapp/phones.ts";
import { whatsappWebhook, type WhatsAppWebhookOptions } from "./whatsapp/webhook.ts";
import { telemetryMiddleware } from "@osiris/platform/telemetry.ts";

export interface ControlDeps {
  verifier: InternalVerifier;
  runtimeIdentity: RuntimeIdentityVerifier;
  directory: TenantDirectory;
  users: UserDirectory;
  orchestrator: Orchestrator;
  schedules: ScheduleStore;
  domains: DomainStore;
  sites: SitePublisher;
  backups: Backups;
  phones: PhoneVerification;
  whatsapp?: WhatsAppWebhookOptions & { displayNumber?: string };
  /** Asks a tenant's runtime for a snapshot now (admin "back up now"). */
  snapshot: (tenant: string) => Promise<void>;
  /** Sign-in: the OIDC provider's state, credentials and the sign-in screens' API. */
  auth: AuthDeps;
}

type Env = { Variables: { call: VerifiedCall & { user: NonNullable<VerifiedCall["user"]> }; tenant: TenantRow; role: Role; runtimeTenant: string } };

const featuresBody = z.object(Object.fromEntries(FEATURES.map((f) => [f, z.boolean().optional()]))) as z.ZodType<Partial<TenantFeatures>>;
const tenantName = z.string().trim().min(1).max(100);
const createTenantBody = z.object({
  id: z.string().trim().max(40).regex(TENANT_SLUG, "Zkratka: malá písmena, číslice a pomlčky"),
  name: tenantName,
  features: featuresBody.optional(),
});
const updateTenantBody = z.object({
  name: tenantName.optional(),
  features: featuresBody.optional(),
  idleMinutes: z.number().int().min(0).max(24 * 60).optional(),
  storageGb: z.number().int().min(1).max(500).optional(),
  disabledTools: z.array(z.string().regex(/^[a-z0-9_]{1,64}$/)).max(200).optional(),
  quotas: z
    .object({
      storageMb: z.number().int().min(1).max(500 * 1024).nullable(),
      tokensPerMonth: z.number().int().min(0).max(1e12).nullable(),
      members: z.number().int().min(1).max(100_000).nullable(),
      schedules: z.number().int().min(0).max(100_000).nullable(),
    })
    .partial()
    .optional(),
});
const defaultsBody = z.object({
  tenant: z.object({
    features: z.object(Object.fromEntries(FEATURES.map((f) => [f, z.boolean()])) as Record<(typeof FEATURES)[number], z.ZodBoolean>),
    quotas: updateTenantBody.shape.quotas.unwrap().required(),
    idleMinutes: z.number().int().min(0).max(24 * 60),
    storageGb: z.number().int().min(1).max(500),
  }),
  user: z.object({ address: z.enum(["auto", "ty", "vy"]), language: z.enum(["auto", "cs", "sk"]) }),
});
const roleBody = z.object({ role: z.enum(["admin", "member"]) });
const personName = z.string().trim().max(50);
const inviteBody = z.object({
  email: z.email().max(200),
  firstName: personName.min(1),
  lastName: personName,
  role: z.enum(["admin", "member"]).default("member"),
});
const profileBody = z.object({ firstName: personName.min(1).optional(), lastName: personName.optional(), email: z.email().max(200).optional() });
const guardBody = z.object({ description: z.string().trim().max(300).default(""), rule: z.string().trim().min(1).max(4000) });
const newUserBody = z.object({ email: z.email().max(200), firstName: personName.min(1), lastName: personName });
const adminUserBody = profileBody.extend({ disabled: z.boolean().optional(), systemAdmin: z.boolean().optional() });
const phoneBody = z.object({ phone: z.string().trim().min(8).max(20).regex(/^\+?[\d\s()-]+$/, "Zadej číslo s předvolbou, např. +420 777 123 456") });
const scheduleBody = z.object({
  title: z.string().trim().min(1).max(100),
  prompt: z.string().trim().min(1).max(4000),
  cron: z.string().trim().max(100).nullable().optional(),
  runAt: z.string().max(40).nullable().optional(),
  timezone: z.string().max(60).optional(),
  delivery: z.enum(["web", "whatsapp"]).optional(),
  enabled: z.boolean().optional(),
});
const runtimeScheduleBody = scheduleBody.extend({ owner: z.object({ id: z.string().min(1), name: z.string().nullable() }) });
const domainBody = z.object({ domain: z.string().trim().min(4).max(253) });

const PICTURE_TYPES: Record<string, number[]> = { "image/png": [0x89, 0x50, 0x4e, 0x47], "image/jpeg": [0xff, 0xd8, 0xff] };

const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const r = schema.safeParse(value);
  if (!r.success) throw new HTTPException(400, { message: z.prettifyError(r.error) });
  return r.data;
};
const json = async (c: Context) => c.req.json().catch(() => {
  throw new HTTPException(400, { message: "Invalid JSON" });
});

/** Maps domain errors of the stores to HTTP answers. */
function errors(err: unknown): HTTPException | null {
  if (err instanceof HTTPException) return err;
  if (err instanceof TenantExistsError) return new HTTPException(409, { message: "Tenant s touto zkratkou už existuje" });
  if (err instanceof TenantNotFoundError) return new HTTPException(404, { message: "Tenant not found" });
  if (err instanceof QuotaError) return new HTTPException(400, { message: err.message });
  if (err instanceof UserNotFoundError) return new HTTPException(404, { message: "User not found" });
  if (err instanceof ScheduleNotFoundError) return new HTTPException(404, { message: err.message });
  if (
    err instanceof UserInputError ||
    err instanceof ScheduleError ||
    err instanceof DomainError ||
    err instanceof PublishError ||
    err instanceof CredentialError ||
    err instanceof SocialLoginError
  ) {
    return new HTTPException(400, { message: err.message });
  }
  if (err instanceof InternalAuthError || err instanceof RuntimeIdentityError) return new HTTPException(401, { message: "Unauthorized" });
  return null;
}

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * Control: sign-in (the OIDC provider's screens; the provider itself is mounted next to this app, see server.ts),
 * tenants, users and their access, schedules, domains and sites, backups, WhatsApp. User calls come from the gateway
 * with an internal token naming the user and their memberships, runtimes prove their tenant with their ServiceAccount
 * token, and Meta signs the WhatsApp webhook.
 */
export function createControlApp(deps: ControlDeps) {
  const { verifier, runtimeIdentity, directory, users, orchestrator, schedules, domains, sites, backups, phones } = deps;
  const tenants = directory.store;

  /** A user call relayed by the gateway. */
  const fromGateway = createMiddleware<Env>(async (c, next) => {
    const call = await verifier.verifyHeader(c.req.header("authorization"), CONTROL_AUDIENCE);
    if (call.issuer !== "gateway" || !call.user) throw new HTTPException(401, { message: "Unauthorized" });
    c.set("call", call as Env["Variables"]["call"]);
    await next();
  });

  /** The tenant of `X-Tenant-Id`, which must be one of the user's memberships and still active. */
  const inTenant = createMiddleware<Env>(async (c, next) => {
    const call = c.get("call");
    const id = c.req.header("x-tenant-id");
    const membership = call.memberships?.find((m) => m.tenantId === id);
    if (!membership) throw new HTTPException(id ? 403 : 400, { message: id ? "Not a member of this tenant" : "X-Tenant-Id header required" });
    const tenant = await tenants.get(membership.tenantId);
    if (!tenant || tenant.status !== "active") throw new HTTPException(403, { message: "Tenant was removed" });
    c.set("tenant", tenant);
    c.set("role", membership.role);
    await next();
  });
  const requireTenantAdmin = (c: Context<Env>) => {
    if (c.get("role") !== "admin") throw new HTTPException(403, { message: "Requires admin role" });
  };
  const requireFeature = (feature: keyof TenantFeatures) =>
    createMiddleware<Env>(async (c, next) => {
      if (!c.get("tenant").features[feature]) throw new HTTPException(403, { message: "Tato funkce není pro tenant povolená" });
      await next();
    });

  const profile = async (userId: string): Promise<UserProfile> => {
    const user = await users.get(userId);
    return { firstName: user.firstName, lastName: user.lastName, email: user.email, phone: user.claims[PHONE_CLAIM] ?? null };
  };

  const tenantDetail = async (t: TenantRow): Promise<TenantDetail> => {
    const memberList = await directory.members(t.id);
    return {
      id: t.id,
      name: t.name,
      logo: t.logo,
      members: memberList.length,
      features: t.features,
      memberList,
      idleMinutes: t.idleMinutes,
      storageGb: t.storageGb,
      disabledTools: t.disabledTools,
      quotas: t.quotas,
      backups: (await backups.list(t.id)).slice(0, 10).map((b) => ({ key: b.key, bytes: b.bytes, reason: b.reason, createdAt: iso(b.createdAt) })),
    };
  };

  // --- the user's own account -------------------------------------------------------------------------------------
  const me = new Hono<Env>()
    .get("/", async (c) => {
      const { user, memberships = [], systemAdmin = false } = c.get("call");
      const active = new Map((await tenants.list()).map((t) => [t.id, t]));
      return c.json<MeResponse>({
        user: { id: user.sub, email: user.email, name: user.name, phone: user.phone, picture: user.picture },
        systemAdmin,
        tenants: memberships.flatMap((m) => {
          const t = active.get(m.tenantId);
          return t ? [{ id: t.id, name: t.name, role: m.role, logo: t.logo }] : [];
        }),
      });
    })
    .get("/profile", async (c) => c.json<UserProfile>(await profile(c.get("call").user.sub)))
    .patch("/profile", async (c) => {
      const changes = parse(profileBody, await json(c));
      await users.updateProfile(c.get("call").user.sub, changes);
      return c.json<UserProfile>(await profile(c.get("call").user.sub));
    })
    .put("/picture", bodyLimit({ maxSize: 2 * 1024 * 1024, onError: (c) => c.json({ error: "Obrázek může mít nejvýš 2 MB" }, 413) }), async (c) => {
      const data = new Uint8Array(await c.req.arrayBuffer());
      const mime = Object.entries(PICTURE_TYPES).find(([, sig]) => sig.every((b, i) => data[i] === b))?.[0];
      if (!mime) throw new HTTPException(415, { message: "Profilový obrázek musí být PNG nebo JPEG" });
      await users.setPicture(c.get("call").user.sub, data, mime);
      return c.body(null, 204);
    })
    .post("/phone", async (c) => {
      const { phone } = parse(phoneBody, await json(c));
      const { code, expiresAt } = await phones.start(c.get("call").user.sub, phone).catch((err: Error) => {
        throw new HTTPException(400, { message: err.message });
      });
      return c.json<UserProfile>({
        ...(await profile(c.get("call").user.sub)),
        phoneChallenge: { phone, code, whatsappNumber: deps.whatsapp?.displayNumber ?? null, expiresAt: iso(expiresAt) },
      });
    })
    .delete("/phone", async (c) => {
      await phones.remove(c.get("call").user.sub);
      return c.body(null, 204);
    })
    .route("/security", securityRoutes(deps.auth, (c) => (c as Context<Env>).get("call").user.sub));

  // --- the active tenant --------------------------------------------------------------------------------------------
  const tenant = new Hono<Env>()
    .use(inTenant)
    .get("/tenant", (c) => {
      const t = c.get("tenant");
      return c.json<TenantInfo>({ id: t.id, name: t.name, role: c.get("role"), features: t.features, logo: t.logo });
    })
    .put("/tenant/logo", bodyLimit({ maxSize: 2 * 1024 * 1024, onError: (c) => c.json({ error: "Obrázek může mít nejvýš 2 MB" }, 413) }), async (c) => {
      requireTenantAdmin(c);
      const data = new Uint8Array(await c.req.arrayBuffer());
      const mime = Object.entries(PICTURE_TYPES).find(([, sig]) => sig.every((b, i) => data[i] === b))?.[0];
      if (!mime) throw new HTTPException(415, { message: "Logo musí být PNG nebo JPEG" });
      await tenants.setLogo(c.get("tenant").id, data, mime);
      return c.body(null, 204);
    })

    // Tenant admins manage their tenant's members; they invite by email and never see other tenants' users.
    .get("/members", async (c) => {
      requireTenantAdmin(c);
      return c.json<TenantMember[]>(await directory.members(c.get("tenant").id));
    })
    .post("/members", async (c) => {
      requireTenantAdmin(c);
      const { role, ...person } = parse(inviteBody, await json(c));
      return c.json<InviteResult>(await directory.invite(c.get("tenant").id, person, role), 201);
    })
    .put("/members/:userId", async (c) => {
      requireTenantAdmin(c);
      const { role } = parse(roleBody, await json(c));
      const id = c.get("tenant").id;
      if (!(await directory.members(id)).some((m) => m.userId === c.req.param("userId"))) throw new HTTPException(404, { message: "Member not found" });
      await directory.setRole(id, c.req.param("userId"), role);
      return c.body(null, 204);
    })
    .delete("/members/:userId", async (c) => {
      requireTenantAdmin(c);
      const id = c.get("tenant").id;
      const userId = c.req.param("userId");
      if (!(await directory.members(id)).some((m) => m.userId === userId)) throw new HTTPException(404, { message: "Member not found" });
      await directory.setRole(id, userId, null);
      await schedules.deleteOwner(id, userId);
      return c.body(null, 204);
    })
    .post("/members/:userId/login-link", async (c) => {
      requireTenantAdmin(c);
      const userId = c.req.param("userId");
      if (!(await directory.members(c.get("tenant").id)).some((m) => m.userId === userId)) throw new HTTPException(404, { message: "Member not found" });
      return c.json({ loginLink: await users.loginLink(userId, 72) });
    })

    // Scheduled tasks: everyone manages their own; admins also see and stop everyone's in the tenant.
    .use("/schedules/*", requireFeature("scheduler"))
    .use("/schedules", requireFeature("scheduler"))
    .get("/schedules", async (c) => {
      const all = c.req.query("all") === "true";
      if (all) requireTenantAdmin(c);
      return c.json<Schedule[]>(await schedules.list(c.get("tenant").id, all ? undefined : c.get("call").user.sub));
    })
    .post("/schedules", async (c) => {
      const { user } = c.get("call");
      const body = parse(scheduleBody, await json(c));
      return c.json<Schedule>(await schedules.create(c.get("tenant").id, { id: user.sub, name: user.name }, body), 201);
    })
    .patch("/schedules/:id", async (c) => {
      const s = await ownSchedule(c);
      return c.json<Schedule>(await schedules.update(c.get("tenant").id, s.id, parse(scheduleBody.partial(), await json(c))));
    })
    .post("/schedules/:id/run", async (c) => {
      const s = await ownSchedule(c);
      return c.json<Schedule>(await schedules.update(c.get("tenant").id, s.id, { enabled: true, runAt: new Date().toISOString(), cron: s.cron }));
    })
    .delete("/schedules/:id", async (c) => {
      const s = await ownSchedule(c);
      await schedules.delete(c.get("tenant").id, s.id);
      return c.body(null, 204);
    })

    // Custom domains and site releases: members see them, admins change them.
    .use("/domains/*", requireFeature("sites"))
    .use("/domains", requireFeature("sites"))
    .use("/sites/*", requireFeature("sites"))
    .get("/domains", async (c) => c.json<SiteDomain[]>(await domains.list(c.get("tenant").id)))
    .post("/domains", async (c) => {
      requireTenantAdmin(c);
      const { domain } = parse(domainBody, await json(c));
      return c.json<SiteDomain>(await domains.add(c.get("tenant").id, domain), 201);
    })
    .post("/domains/:domain/verify", async (c) => {
      requireTenantAdmin(c);
      const id = c.get("tenant").id;
      const result = await domains.verify(id, c.req.param("domain"));
      // The ingress and certificate follow the verified set.
      await directory.sync(id);
      return c.json<SiteDomain>(result);
    })
    .delete("/domains/:domain", async (c) => {
      requireTenantAdmin(c);
      const id = c.get("tenant").id;
      const domain = c.req.param("domain");
      await domains.remove(id, domain);
      await directory.sync(id);
      await sites.removeDomain(id, domain);
      return c.body(null, 204);
    })
    .get("/sites/releases", async (c) => c.json<SiteRelease[]>(await sites.releases(c.get("tenant").id, c.req.query("domain"))))
    .post("/sites/releases/:id/activate", async (c) => {
      requireTenantAdmin(c);
      const { domain } = parse(domainBody, await json(c));
      await sites.activate(c.get("tenant").id, domain, c.req.param("id"));
      return c.body(null, 204);
    });

  /** A schedule the caller may change: their own, or any in the tenant for an admin. */
  async function ownSchedule(c: Context<Env>) {
    const s = await schedules.get(c.get("tenant").id, c.req.param("id")!);
    if (s.ownerId !== c.get("call").user.sub && c.get("role") !== "admin") throw new HTTPException(404, { message: "Úloha nenalezena" });
    return s;
  }

  // --- system administration (claim role=osiris-admin) ------------------------------------------------------------
  const admin = new Hono<Env>()
    .use(async (c, next) => {
      if (!c.get("call").systemAdmin) throw new HTTPException(403, { message: "Requires osiris-admin" });
      await next();
    })
    .get("/tenants", async (c) => c.json<TenantSummary[]>(await directory.list()))
    .post("/tenants", async (c) => {
      const { id, name, features } = parse(createTenantBody, await json(c));
      const t = await directory.create(id, name, features);
      return c.json<TenantSummary>({ id: t.id, name: t.name, logo: t.logo, members: 0 }, 201);
    })
    .get("/tenants/:id", async (c) => c.json<TenantDetail>(await tenantDetail(await tenants.active(c.req.param("id")))))
    .patch("/tenants/:id", async (c) => {
      const changes = parse(updateTenantBody, await json(c));
      await directory.update(c.req.param("id"), changes);
      return c.body(null, 204);
    })
    .delete("/tenants/:id", async (c) => {
      await directory.remove(c.req.param("id"));
      return c.body(null, 204);
    })
    .put("/tenants/:id/members/:userId", async (c) => {
      const { role } = parse(roleBody, await json(c));
      await directory.setRole(c.req.param("id"), c.req.param("userId"), role);
      return c.body(null, 204);
    })
    .delete("/tenants/:id/members/:userId", async (c) => {
      await directory.setRole(c.req.param("id"), c.req.param("userId"), null);
      await schedules.deleteOwner(c.req.param("id"), c.req.param("userId"));
      return c.body(null, 204);
    })
    .post("/tenants/:id/members", async (c) => {
      const { role, ...person } = parse(inviteBody, await json(c));
      return c.json<InviteResult>(await directory.invite(c.req.param("id"), person, role), 201);
    })
    .post("/tenants/:id/backups", async (c) => {
      await tenants.active(c.req.param("id"));
      await deps.snapshot(c.req.param("id"));
      return c.body(null, 202);
    })
    .get("/defaults", async (c) => c.json<SystemDefaults>(await tenants.defaults()))
    .put("/defaults", async (c) => {
      const d = parse(defaultsBody, await json(c));
      await tenants.setDefaults(d);
      return c.json<SystemDefaults>(d);
    })
    .get("/guards", async (c) => c.json<Guard[]>(await tenants.systemGuards()))
    .put("/guards/:name", async (c) => {
      const name = c.req.param("name");
      if (!GUARD_NAME.test(name) || name.length > 60) throw new HTTPException(400, { message: "Název: malá písmena, číslice a pomlčky" });
      const guard = { name, ...parse(guardBody, await json(c)) };
      await tenants.putSystemGuard(guard);
      return c.json<Guard>(guard);
    })
    .delete("/guards/:name", async (c) => {
      if (!(await tenants.deleteSystemGuard(c.req.param("name")))) throw new HTTPException(404, { message: "Pravidlo neexistuje" });
      return c.body(null, 204);
    })
    .get("/users", async (c) => c.json<AdminUser[]>(await directory.adminUsers()))
    // A new user gets in with a one-time link; access comes from tenants and the system admin switch afterwards.
    .post("/users", async (c) => {
      const person = parse(newUserBody, await json(c));
      if (await users.findByEmail(person.email)) throw new HTTPException(409, { message: "Uživatel s tímto e-mailem už existuje" });
      const user = await users.create({ ...person, claims: { [CLAIMS.role]: USER_ROLE } });
      return c.json({ userId: user.id, loginLink: await users.loginLink(user.id, 72, "invite") }, 201);
    })
    .patch("/users/:id", async (c) => {
      const id = c.req.param("id");
      const { disabled, systemAdmin, ...profile } = parse(adminUserBody, await json(c));
      // Nobody locks themselves out of the administration.
      if (id === c.get("call").user.sub && (disabled === true || systemAdmin === false)) {
        throw new HTTPException(400, { message: "Sám sobě účet nezablokuješ ani neodebereš správu systému" });
      }
      const user = await users.get(id);
      if (Object.keys(profile).length) await users.updateProfile(id, profile);
      if (disabled !== undefined) await users.setDisabled(id, disabled);
      if (systemAdmin !== undefined) {
        const roles = claimList(user.claims[CLAIMS.role]).filter((r) => r !== SYSTEM_ADMIN_ROLE && r !== USER_ROLE);
        await users.setClaims(id, { [CLAIMS.role]: [...roles, systemAdmin ? SYSTEM_ADMIN_ROLE : USER_ROLE].join(",") });
      }
      return c.body(null, 204);
    })
    .post("/users/:id/login-link", async (c) => {
      const user = await users.get(c.req.param("id"));
      if (user.disabled) throw new HTTPException(400, { message: "Účet je zablokovaný" });
      return c.json({ loginLink: await users.loginLink(user.id, 72, "admin") });
    })
    // A user who lost both their authenticator and recovery codes gets in again with password or passkey alone.
    .delete("/users/:id/second-factor", async (c) => {
      await users.get(c.req.param("id"));
      await deps.auth.credentials.disableTotp(c.req.param("id"));
      return c.body(null, 204);
    });

  // --- the gateway's own calls --------------------------------------------------------------------------------------
  const forGateway = new Hono()
    .use(async (c, next) => {
      const call = await verifier.verifyHeader(c.req.header("authorization"), CONTROL_AUDIENCE);
      if (call.issuer !== "gateway") throw new HTTPException(401, { message: "Unauthorized" });
      await next();
    })
    .get("/tenants", async (c) => c.json((await tenants.list()).map((t) => ({ id: t.id, name: t.name }))))
    // Who an access token belongs to: the gateway asks for every token it hasn't seen in the last minute.
    .post("/identify", async (c) => {
      const { token } = parse(z.object({ token: z.string().min(1).max(4096) }), await json(c));
      const access = await deps.auth.provider.AccessToken.find(token);
      if (!access || access.isExpired || access.clientId !== WEB_CLIENT_ID || !access.accountId) throw new HTTPException(401, { message: "Invalid token" });
      const user = await users.get(access.accountId).catch(() => null);
      if (!user || user.disabled) throw new HTTPException(401, { message: "Invalid token" });
      return c.json({
        sub: user.id,
        email: user.email,
        name: user.name,
        phone: user.claims[PHONE_CLAIM] ?? null,
        picture: user.picture,
        claims: { [CLAIMS.role]: user.claims[CLAIMS.role], [CLAIMS.tenant]: user.claims[CLAIMS.tenant], [CLAIMS.tenantAdmin]: user.claims[CLAIMS.tenantAdmin] },
        expiresAt: (access.exp ?? 0) * 1000,
      });
    })
    .get("/tenants/:id/endpoint", async (c) => {
      await tenants.active(c.req.param("id"));
      return c.json({ url: orchestrator.endpoint(c.req.param("id")) });
    })
    .post("/tenants/:id/wake", async (c) => {
      await tenants.active(c.req.param("id"));
      await orchestrator.wake(c.req.param("id"));
      return c.body(null, 204);
    });

  // --- tenant runtimes (ServiceAccount token; the tenant comes from it, never from the request) ---------------------
  const forRuntime = new Hono<Env>()
    .use(async (c, next) => {
      const token = c.req.header("authorization")?.match(/^Bearer (.+)$/i)?.[1];
      if (!token) throw new HTTPException(401, { message: "Unauthorized" });
      const { tenant } = await runtimeIdentity.verify(token);
      const row = await tenants.get(tenant);
      if (!row) throw new HTTPException(404, { message: "Tenant not found" });
      c.set("runtimeTenant", tenant);
      c.set("tenant", row);
      await next();
    })
    // A runtime telling its tenant's admins something (a new inquiry from the public assistant), by email.
    .post("/notify-admins", async (c) => {
      const { subject, text } = parse(z.object({ subject: z.string().trim().min(1).max(200), text: z.string().max(10_000) }), await json(c));
      const mailer = deps.auth.mailer;
      if (!mailer) return c.json({ sent: 0 });
      const admins = (await directory.members(c.get("runtimeTenant"))).filter((m) => m.role === "admin" && m.email);
      await Promise.all(admins.map((m) => mailer.send({ to: m.email!, subject: `Osiris: ${subject}`, text })));
      return c.json({ sent: admins.length });
    })
    .get("/tenant", async (c) => {
      const t = c.get("tenant");
      return c.json({
        id: t.id,
        name: t.name,
        status: t.status,
        features: t.features,
        disabledTools: t.disabledTools,
        quotas: t.quotas,
        // What the runtime shows next to the quotas it doesn't count itself.
        counts: { members: await directory.memberCount(t.id), schedules: (await schedules.list(t.id)).length },
        systemGuards: await tenants.systemGuards(),
        userDefaults: (await tenants.defaults()).user,
      });
    })
    .put("/backups", async (c) => {
      const body = c.req.raw.body;
      if (!body) throw new HTTPException(400, { message: "Missing body" });
      const info = await backups.store(c.get("runtimeTenant"), Readable.fromWeb(body as never), c.req.query("reason") ?? "manual");
      return c.json(info, 201);
    })
    .get("/backups/latest", async (c) => {
      const latest = await backups.latest(c.get("runtimeTenant"));
      if (!latest) return c.json({ error: "No backup" }, 404);
      return new Response(Readable.toWeb(latest.body) as ReadableStream, {
        headers: { "content-type": "application/gzip", "x-backup-key": latest.info.key },
      });
    })
    .get("/schedules", async (c) => c.json<Schedule[]>(await schedules.list(c.get("runtimeTenant"), c.req.query("owner") || undefined)))
    .post("/schedules", async (c) => {
      if (!c.get("tenant").features.scheduler) throw new HTTPException(403, { message: "Plánované úlohy nejsou pro tenant povolené" });
      const { owner, ...body } = parse(runtimeScheduleBody, await json(c));
      return c.json<Schedule>(await schedules.create(c.get("runtimeTenant"), owner, body), 201);
    })
    .delete("/schedules/:id", async (c) => {
      const s = await schedules.get(c.get("runtimeTenant"), c.req.param("id"));
      const owner = c.req.query("owner");
      if (owner && s.ownerId !== owner) throw new HTTPException(404, { message: "Úloha nenalezena" });
      await schedules.delete(c.get("runtimeTenant"), s.id);
      return c.body(null, 204);
    })
    .get("/domains", async (c) => c.json<SiteDomain[]>(await domains.list(c.get("runtimeTenant"))))
    .post(
      "/sites/publish",
      bodyLimit({ maxSize: SITE_LIMITS.uploadBytes, onError: (c) => c.json({ error: "Web je příliš velký" }, 413) }),
      async (c) => {
        if (!c.get("tenant").features.sites) throw new HTTPException(403, { message: "Weby nejsou pro tenant povolené" });
        const domain = c.req.query("domain") ?? "";
        const body = c.req.raw.body;
        if (!body) throw new HTTPException(400, { message: "Missing body" });
        const release = await sites.publish(c.get("runtimeTenant"), domain, Readable.fromWeb(body as never), c.req.query("user") ?? null);
        return c.json<SiteRelease>(release, 201);
      },
    );

  const app = new Hono()
    .use(telemetryMiddleware())
    .get("/health", (c) => c.json({ ok: true }))
    // Tenant logos, public like profile pictures (an <img> sends no token); the version in the URL is unguessable.
    .get("/auth/tenant-logos/:id/:version", async (c) => {
      const logo = await tenants.logo(c.req.param("id"), c.req.param("version"));
      if (!logo) return c.body(null, 404);
      const data = await readAll(logo.body);
      return c.body(new Uint8Array(data), 200, {
        "content-type": data[0] === 0x89 ? "image/png" : "image/jpeg",
        "cache-control": "public, max-age=31536000, immutable",
        "x-content-type-options": "nosniff",
      });
    })
    .route("/auth", authRoutes(deps.auth))
    .route("/internal/gateway", forGateway)
    .route("/internal/runtime", forRuntime)
    .route("/webhooks/whatsapp", deps.whatsapp ? whatsappWebhook(deps.whatsapp) : new Hono().all("/", (c) => c.text("WhatsApp is not configured", 404)))
    .route(
      "/api",
      new Hono<Env>().use(fromGateway).route("/me", me).route("/admin", admin).route("/", tenant),
    );

  return app.onError((err, c) => {
    const http = errors(err);
    if (http) return c.json({ error: http.message }, http.status);
    console.error(err);
    return c.json({ error: "Internal server error" }, 500);
  });
}
