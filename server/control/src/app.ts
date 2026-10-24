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
  type ProjectDetail,
  type ProjectFeatures,
  type ProjectInfo,
  type ProjectMember,
  type ProjectSummary,
  type UserProfile,
} from "@osiris/shared";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import type { Telemetry } from "./telemetry/clickhouse.ts";
import { DashboardStore, systemDashboardRoutes, projectAnalyticsRoutes, projectDashboardRoutes } from "./dashboards.ts";
import { telemetryRoutes } from "./telemetry/routes.ts";
import { z } from "zod";
import { CLAIMS, claimList, SYSTEM_ADMIN_ROLE, PROJECT_SLUG, USER_ROLE } from "@osiris/platform/claims.ts";
import { CONTROL_AUDIENCE, InternalAuthError, type InternalVerifier, type VerifiedCall } from "@osiris/platform/internal-auth.ts";
import { RuntimeIdentityError, type RuntimeIdentityVerifier } from "@osiris/platform/runtime-identity.ts";
import { CLIENT_IDS } from "./auth/oidc.ts";
import { authRoutes, securityRoutes, type AuthDeps } from "./auth/routes.ts";
import type { Backups } from "./backups.ts";
import type { Orchestrator } from "./orchestrator/types.ts";
import { ScheduleNotFoundError, type ScheduleStore } from "./scheduler.ts";
import { ProjectExistsError, ProjectNotFoundError, type ProjectDirectory, type ProjectRow } from "./projects.ts";
import { UserNotFoundError, type UserDirectory } from "./users.ts";
import { PHONE_CLAIM, type PhoneVerification } from "./whatsapp/phones.ts";
import { whatsappWebhook, type WhatsAppWebhookOptions } from "./whatsapp/webhook.ts";
import { telemetryMiddleware } from "@osiris/platform/telemetry.ts";
import { errorResponse, HttpError, requestLocale, translate, ValidationError, type Params } from "@osiris/platform/i18n.ts";

export interface ControlDeps {
  verifier: InternalVerifier;
  runtimeIdentity: RuntimeIdentityVerifier;
  directory: ProjectDirectory;
  users: UserDirectory;
  orchestrator: Orchestrator;
  schedules: ScheduleStore;
  backups: Backups;
  phones: PhoneVerification;
  whatsapp?: WhatsAppWebhookOptions & { displayNumber?: string };
  /** Asks a project's runtime for a snapshot now (admin "back up now"). */
  snapshot: (project: string) => Promise<void>;
  /** Sign-in: the OIDC provider's state, credentials and the sign-in screens' API. */
  auth: AuthDeps;
  /** The cluster's telemetry in ClickHouse, for system admins; without it those pages say it isn't set up. */
  telemetry?: Telemetry;
  dashboards: DashboardStore;
}

type Env = { Variables: { call: VerifiedCall & { user: NonNullable<VerifiedCall["user"]> }; project: ProjectRow; role: Role; runtimeProject: string } };

const featuresBody = z.object(Object.fromEntries(FEATURES.map((f) => [f, z.boolean().optional()]))) as z.ZodType<Partial<ProjectFeatures>>;
const projectName = z.string().trim().min(1).max(100);
const createProjectBody = z.object({
  id: z.string().trim().max(40).regex(PROJECT_SLUG, "errors.validation.slug"),
  name: projectName,
  features: featuresBody.optional(),
});
const updateProjectBody = z.object({
  name: projectName.optional(),
  features: featuresBody.optional(),
  idleMinutes: z.number().int().min(0).max(24 * 60).optional(),
  storageGb: z.number().int().min(1).max(500).optional(),
  disabledTools: z.array(z.string().regex(/^[a-z0-9_]{1,64}$/)).max(200).optional(),
  webSites: z.array(z.string().trim().min(1).max(253)).max(100).optional(),
  quotas: z
    .object({
      storageMb: z.number().int().min(1).max(500 * 1024).nullable(),
      tokensPerMonth: z.number().int().min(0).max(1e12).nullable(),
      members: z.number().int().min(1).max(100_000).nullable(),
      schedules: z.number().int().min(0).max(100_000).nullable(),
      dashboards: z.number().int().min(0).max(1000).nullable(),
      tokensPerUserMonth: z.number().int().min(0).max(1e12).nullable(),
      tables: z.number().int().min(0).max(10_000).nullable(),
      databaseMb: z.number().int().min(1).max(500 * 1024).nullable(),
    })
    .partial()
    .optional(),
});
const defaultsBody = z.object({
  project: z.object({
    features: z.object(Object.fromEntries(FEATURES.map((f) => [f, z.boolean()])) as Record<(typeof FEATURES)[number], z.ZodBoolean>),
    quotas: updateProjectBody.shape.quotas.unwrap().required(),
    idleMinutes: z.number().int().min(0).max(24 * 60),
    storageGb: z.number().int().min(1).max(500),
  }),
  user: z.object({
    address: z.enum(["auto", "ty", "vy"]),
    language: z.enum(["auto", "en", "cs", "sk"]),
    signature: z.string().trim().max(1000),
    instructions: z.string().trim().max(4000),
    persona: z
      .object({ character: z.string().trim().min(1).max(100), source: z.string().trim().max(150), description: z.string().trim().min(1).max(2000) })
      .nullable(),
  }),
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
const phoneBody = z.object({ phone: z.string().trim().min(8).max(20).regex(/^\+?[\d\s()-]+$/, "errors.validation.phone") });
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

const PICTURE_TYPES: Record<string, number[]> = { "image/png": [0x89, 0x50, 0x4e, 0x47], "image/jpeg": [0xff, 0xd8, 0xff] };

const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const r = schema.safeParse(value, { reportInput: true });
  if (!r.success) throw new ValidationError(r.error);
  return r.data;
};
const json = async (c: Context) => c.req.json().catch(() => {
  throw new HttpError(400, "errors.invalidJson");
});

/**
 * Maps errors of the stores to HTTP errors. The stores' own input errors (`ScheduleError`, …) are
 * `LocalizedError`s and answer 400 in `onError`.
 */
function errors(err: unknown): Error | null {
  if (err instanceof HTTPException || err instanceof HttpError) return err;
  if (err instanceof ProjectExistsError) return new HttpError(409, "errors.project.exists");
  if (err instanceof ProjectNotFoundError) return new HttpError(404, "errors.project.notFound");
  if (err instanceof UserNotFoundError) return new HttpError(404, "errors.user.notFound");
  if (err instanceof ScheduleNotFoundError) return new HttpError(404, err.key, err.params);
  if (err instanceof InternalAuthError || err instanceof RuntimeIdentityError) return new HTTPException(401, { message: "Unauthorized" });
  return null;
}

const iso = (ms: number) => new Date(ms).toISOString();

const tooLarge = (key: string, params?: Params) => (c: Context) => c.json({ error: translate(requestLocale(c.req.header("accept-language")), key, params), code: key }, 413);

/**
 * Control: sign-in (the OIDC provider's screens; the provider itself is mounted next to this app, see server.ts),
 * projects, users and their access, schedules, backups, WhatsApp. User calls come from the gateway
 * with an internal token naming the user and their memberships, runtimes prove their project with their ServiceAccount
 * token, and Meta signs the WhatsApp webhook.
 */
export function createControlApp(deps: ControlDeps) {
  const { verifier, runtimeIdentity, directory, users, orchestrator, schedules, backups, phones } = deps;
  const projects = directory.store;
  const dashboardDeps = { store: deps.dashboards, projects, directory, schedules, backups, orchestrator, telemetry: deps.telemetry };

  /** A user call relayed by the gateway. */
  const fromGateway = createMiddleware<Env>(async (c, next) => {
    const call = await verifier.verifyHeader(c.req.header("authorization"), CONTROL_AUDIENCE);
    if (call.issuer !== "gateway" || !call.user) throw new HTTPException(401, { message: "Unauthorized" });
    c.set("call", call as Env["Variables"]["call"]);
    await next();
  });

  /** The project of `X-Project-Id`, which must be one of the user's memberships and still active. */
  const inProject = createMiddleware<Env>(async (c, next) => {
    const call = c.get("call");
    const id = c.req.header("x-project-id");
    const membership = call.memberships?.find((m) => m.projectId === id);
    if (!membership) throw id ? new HttpError(403, "errors.access.notMember") : new HttpError(400, "errors.projectRequired");
    const project = await projects.get(membership.projectId);
    if (!project || project.status !== "active") throw new HttpError(403, "errors.project.removed");
    c.set("project", project);
    c.set("role", membership.role);
    await next();
  });
  const requireProjectAdmin = (c: Context<Env>) => {
    if (c.get("role") !== "admin") throw new HttpError(403, "errors.access.adminOnly");
  };
  const requireFeature = (feature: keyof ProjectFeatures) =>
    createMiddleware<Env>(async (c, next) => {
      if (!c.get("project").features[feature]) throw new HttpError(403, "errors.featureOff");
      await next();
    });

  const profile = async (userId: string): Promise<UserProfile> => {
    const user = await users.get(userId);
    return { firstName: user.firstName, lastName: user.lastName, email: user.email, phone: user.claims[PHONE_CLAIM] ?? null };
  };

  const projectDetail = async (t: ProjectRow): Promise<ProjectDetail> => {
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
      webSites: t.webSites,
      backups: (await backups.list(t.id)).slice(0, 10).map((b) => ({ key: b.key, bytes: b.bytes, reason: b.reason, createdAt: iso(b.createdAt) })),
    };
  };

  // --- the user's own account -------------------------------------------------------------------------------------
  const me = new Hono<Env>()
    .get("/", async (c) => {
      const { user, memberships = [], systemAdmin = false } = c.get("call");
      const active = new Map((await projects.list()).map((t) => [t.id, t]));
      return c.json<MeResponse>({
        user: { id: user.sub, email: user.email, name: user.name, phone: user.phone, picture: user.picture },
        systemAdmin,
        projects: memberships.flatMap((m) => {
          const t = active.get(m.projectId);
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
    .put("/picture", bodyLimit({ maxSize: 2 * 1024 * 1024, onError: tooLarge("errors.image.tooLarge", { mb: 2 }) }), async (c) => {
      const data = new Uint8Array(await c.req.arrayBuffer());
      const mime = Object.entries(PICTURE_TYPES).find(([, sig]) => sig.every((b, i) => data[i] === b))?.[0];
      if (!mime) throw new HttpError(415, "errors.image.pictureType");
      await users.setPicture(c.get("call").user.sub, data, mime);
      return c.body(null, 204);
    })
    .post("/phone", async (c) => {
      const { phone } = parse(phoneBody, await json(c));
      const { code, expiresAt } = await phones.start(c.get("call").user.sub, phone);
      return c.json<UserProfile>({
        ...(await profile(c.get("call").user.sub)),
        phoneChallenge: { phone, code, whatsappNumber: deps.whatsapp?.displayNumber ?? null, expiresAt: iso(expiresAt) },
      });
    })
    .delete("/phone", async (c) => {
      await phones.remove(c.get("call").user.sub);
      return c.body(null, 204);
    })
    .route("/security", securityRoutes(deps.auth, (c) => (c as Context<Env>).get("call").user.sub, (c) => (c as Context<Env>).get("call").sessionUid));

  // --- the active project --------------------------------------------------------------------------------------------
  const project = new Hono<Env>()
    .use(inProject)
    .use("/analytics", requireFeature("sites"))
    .route(
      "/analytics",
      projectAnalyticsRoutes(dashboardDeps, (c) => (c as Context<Env>).get("project").id),
    )
    .route(
      "/dashboards",
      projectDashboardRoutes(dashboardDeps, (c) => {
        const x = c as Context<Env>;
        return { project: x.get("project").id, role: x.get("role"), user: x.get("call").user.sub, quotas: x.get("project").quotas };
      }),
    )
    .get("/project", (c) => {
      const t = c.get("project");
      return c.json<ProjectInfo>({ id: t.id, name: t.name, role: c.get("role"), features: t.features, logo: t.logo });
    })
    .put("/project/logo", bodyLimit({ maxSize: 2 * 1024 * 1024, onError: tooLarge("errors.image.tooLarge", { mb: 2 }) }), async (c) => {
      requireProjectAdmin(c);
      const data = new Uint8Array(await c.req.arrayBuffer());
      const mime = Object.entries(PICTURE_TYPES).find(([, sig]) => sig.every((b, i) => data[i] === b))?.[0];
      if (!mime) throw new HttpError(415, "errors.image.logoType");
      await projects.setLogo(c.get("project").id, data, mime);
      return c.body(null, 204);
    })

    // Project admins manage their project's members; they invite by email and never see other projects' users.
    .get("/members", async (c) => {
      requireProjectAdmin(c);
      return c.json<ProjectMember[]>(await directory.members(c.get("project").id));
    })
    .post("/members", async (c) => {
      requireProjectAdmin(c);
      const { role, ...person } = parse(inviteBody, await json(c));
      return c.json<InviteResult>(await directory.invite(c.get("project").id, person, role), 201);
    })
    .put("/members/:userId", async (c) => {
      requireProjectAdmin(c);
      const { role } = parse(roleBody, await json(c));
      const id = c.get("project").id;
      if (!(await directory.members(id)).some((m) => m.userId === c.req.param("userId"))) throw new HttpError(404, "errors.member.notFound");
      await directory.setRole(id, c.req.param("userId"), role);
      return c.body(null, 204);
    })
    .delete("/members/:userId", async (c) => {
      requireProjectAdmin(c);
      const id = c.get("project").id;
      const userId = c.req.param("userId");
      if (!(await directory.members(id)).some((m) => m.userId === userId)) throw new HttpError(404, "errors.member.notFound");
      await directory.setRole(id, userId, null);
      await schedules.deleteOwner(id, userId);
      return c.body(null, 204);
    })
    .post("/members/:userId/login-link", async (c) => {
      requireProjectAdmin(c);
      const userId = c.req.param("userId");
      if (!(await directory.members(c.get("project").id)).some((m) => m.userId === userId)) throw new HttpError(404, "errors.member.notFound");
      return c.json({ loginLink: await users.loginLink(userId, 72) });
    })

    // Scheduled tasks: everyone manages their own; admins also see and stop everyone's in the project.
    .use("/schedules/*", requireFeature("scheduler"))
    .use("/schedules", requireFeature("scheduler"))
    .get("/schedules", async (c) => {
      const all = c.req.query("all") === "true";
      if (all) requireProjectAdmin(c);
      return c.json<Schedule[]>(await schedules.list(c.get("project").id, all ? undefined : c.get("call").user.sub));
    })
    .post("/schedules", async (c) => {
      const { user } = c.get("call");
      const body = parse(scheduleBody, await json(c));
      return c.json<Schedule>(await schedules.create(c.get("project").id, { id: user.sub, name: user.name }, body), 201);
    })
    .patch("/schedules/:id", async (c) => {
      const s = await ownSchedule(c);
      return c.json<Schedule>(await schedules.update(c.get("project").id, s.id, parse(scheduleBody.partial(), await json(c))));
    })
    .post("/schedules/:id/run", async (c) => {
      const s = await ownSchedule(c);
      return c.json<Schedule>(await schedules.update(c.get("project").id, s.id, { enabled: true, runAt: new Date().toISOString(), cron: s.cron }));
    })
    .delete("/schedules/:id", async (c) => {
      const s = await ownSchedule(c);
      await schedules.delete(c.get("project").id, s.id);
      return c.body(null, 204);
    });

  /** A schedule the caller may change: their own, or any in the project for an admin. */
  async function ownSchedule(c: Context<Env>) {
    const s = await schedules.get(c.get("project").id, c.req.param("id")!);
    if (s.ownerId !== c.get("call").user.sub && c.get("role") !== "admin") throw new HttpError(404, "errors.schedule.notFound");
    return s;
  }

  // --- system administration (claim role=osiris-admin) ------------------------------------------------------------
  const admin = new Hono<Env>()
    .use(async (c, next) => {
      if (!c.get("call").systemAdmin) throw new HttpError(403, "errors.access.systemAdminOnly");
      await next();
    })
    .get("/projects", async (c) => c.json<ProjectSummary[]>(await directory.list()))
    .post("/projects", async (c) => {
      const { id, name, features } = parse(createProjectBody, await json(c));
      const t = await directory.create(id, name, features);
      return c.json<ProjectSummary>({ id: t.id, name: t.name, logo: t.logo, members: 0 }, 201);
    })
    .get("/projects/:id", async (c) => c.json<ProjectDetail>(await projectDetail(await projects.active(c.req.param("id")))))
    .patch("/projects/:id", async (c) => {
      const changes = parse(updateProjectBody, await json(c));
      await directory.update(c.req.param("id"), changes);
      return c.body(null, 204);
    })
    .delete("/projects/:id", async (c) => {
      await directory.remove(c.req.param("id"));
      return c.body(null, 204);
    })
    .put("/projects/:id/members/:userId", async (c) => {
      const { role } = parse(roleBody, await json(c));
      await directory.setRole(c.req.param("id"), c.req.param("userId"), role);
      return c.body(null, 204);
    })
    .delete("/projects/:id/members/:userId", async (c) => {
      await directory.setRole(c.req.param("id"), c.req.param("userId"), null);
      await schedules.deleteOwner(c.req.param("id"), c.req.param("userId"));
      return c.body(null, 204);
    })
    .post("/projects/:id/members", async (c) => {
      const { role, ...person } = parse(inviteBody, await json(c));
      return c.json<InviteResult>(await directory.invite(c.req.param("id"), person, role), 201);
    })
    .post("/projects/:id/backups", async (c) => {
      await projects.active(c.req.param("id"));
      await deps.snapshot(c.req.param("id"));
      return c.body(null, 202);
    })
    .route("/telemetry", telemetryRoutes(deps.telemetry))
    .route("/dashboards", systemDashboardRoutes(dashboardDeps, (c) => (c as Context<Env>).get("call").user.sub))
    .get("/defaults", async (c) => c.json<SystemDefaults>(await projects.defaults()))
    .put("/defaults", async (c) => {
      const d = parse(defaultsBody, await json(c));
      await projects.setDefaults(d);
      return c.json<SystemDefaults>(d);
    })
    .get("/guards", async (c) => c.json<Guard[]>(await projects.systemGuards()))
    .put("/guards/:name", async (c) => {
      const name = c.req.param("name");
      if (!GUARD_NAME.test(name) || name.length > 60) throw new HttpError(400, "errors.validation.name");
      const guard = { name, ...parse(guardBody, await json(c)) };
      await projects.putSystemGuard(guard);
      return c.json<Guard>(guard);
    })
    .delete("/guards/:name", async (c) => {
      if (!(await projects.deleteSystemGuard(c.req.param("name")))) throw new HttpError(404, "errors.guard.notFound");
      return c.body(null, 204);
    })
    .get("/users", async (c) => c.json<AdminUser[]>(await directory.adminUsers()))
    // A new user gets in with a one-time link; access comes from projects and the system admin switch afterwards.
    .post("/users", async (c) => {
      const person = parse(newUserBody, await json(c));
      if (await users.findByEmail(person.email)) throw new HttpError(409, "errors.user.emailTaken");
      const user = await users.create({ ...person, claims: { [CLAIMS.role]: USER_ROLE } });
      return c.json({ userId: user.id, loginLink: await users.loginLink(user.id, 72, "invite") }, 201);
    })
    .patch("/users/:id", async (c) => {
      const id = c.req.param("id");
      const { disabled, systemAdmin, ...profile } = parse(adminUserBody, await json(c));
      // Nobody locks themselves out of the administration.
      if (id === c.get("call").user.sub && (disabled === true || systemAdmin === false)) {
        throw new HttpError(400, "errors.user.selfLockout");
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
      if (user.disabled) throw new HttpError(400, "errors.user.disabled");
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
    .get("/projects", async (c) => c.json((await projects.list()).map((t) => ({ id: t.id, name: t.name }))))
    // Who an access token belongs to: the gateway asks for every token it hasn't seen in the last minute.
    .post("/identify", async (c) => {
      const { token } = parse(z.object({ token: z.string().min(1).max(4096) }), await json(c));
      const access = await deps.auth.provider.AccessToken.find(token);
      if (!access || access.isExpired || !CLIENT_IDS.includes(access.clientId ?? "") || !access.accountId) throw new HTTPException(401, { message: "Invalid token" });
      if (access.sessionUid) await deps.auth.activity.touch(access.sessionUid);
      const user = await users.get(access.accountId).catch(() => null);
      if (!user || user.disabled) throw new HTTPException(401, { message: "Invalid token" });
      return c.json({
        sub: user.id,
        email: user.email,
        name: user.name,
        phone: user.claims[PHONE_CLAIM] ?? null,
        picture: user.picture,
        claims: { [CLAIMS.role]: user.claims[CLAIMS.role], [CLAIMS.project]: user.claims[CLAIMS.project], [CLAIMS.projectAdmin]: user.claims[CLAIMS.projectAdmin] },
        expiresAt: (access.exp ?? 0) * 1000,
        sessionUid: access.sessionUid,
      });
    })
    .get("/projects/:id/endpoint", async (c) => {
      await projects.active(c.req.param("id"));
      return c.json({ url: orchestrator.endpoint(c.req.param("id")) });
    })
    .post("/projects/:id/wake", async (c) => {
      await projects.active(c.req.param("id"));
      await orchestrator.wake(c.req.param("id"));
      return c.body(null, 204);
    });

  // --- project runtimes (ServiceAccount token; the project comes from it, never from the request) ---------------------
  const forRuntime = new Hono<Env>()
    .use(async (c, next) => {
      const token = c.req.header("authorization")?.match(/^Bearer (.+)$/i)?.[1];
      if (!token) throw new HTTPException(401, { message: "Unauthorized" });
      const { project } = await runtimeIdentity.verify(token);
      const row = await projects.get(project);
      if (!row) throw new HTTPException(404, { message: "Project not found" });
      c.set("runtimeProject", project);
      c.set("project", row);
      await next();
    })
    // A runtime telling its project's admins something (a new inquiry from the public assistant), by email.
    .post("/notify-admins", async (c) => {
      const { subject, text } = parse(z.object({ subject: z.string().trim().min(1).max(200), text: z.string().max(10_000) }), await json(c));
      const mailer = deps.auth.mailer;
      if (!mailer) return c.json({ sent: 0 });
      const admins = (await directory.members(c.get("runtimeProject"))).filter((m) => m.role === "admin" && m.email);
      await Promise.all(admins.map((m) => mailer.send({ to: m.email!, subject: `Osiris: ${subject}`, text })));
      return c.json({ sent: admins.length });
    })
    .get("/project", async (c) => {
      const t = c.get("project");
      return c.json({
        id: t.id,
        name: t.name,
        status: t.status,
        features: t.features,
        disabledTools: t.disabledTools,
        quotas: t.quotas,
        // What the runtime shows next to the quotas it doesn't count itself.
        counts: { members: await directory.memberCount(t.id), schedules: (await schedules.list(t.id)).length, dashboards: await deps.dashboards.count(t.id) },
        systemGuards: await projects.systemGuards(),
        userDefaults: (await projects.defaults()).user,
      });
    })
    // The runtime's use (files, tokens this month, tables, database), sent when it changes; for System > Dashboard.
    .put("/usage", async (c) => {
      const usage = parse(
        z.object({ storage: z.number().min(0), tokens: z.number().min(0), month: z.string().regex(/^\d{4}-\d{2}$/), tables: z.number().int().min(0), database: z.number().min(0) }),
        await json(c),
      );
      await projects.reportUsage(c.get("runtimeProject"), usage);
      return c.body(null, 204);
    })
    .put("/backups", async (c) => {
      const body = c.req.raw.body;
      if (!body) throw new HTTPException(400, { message: "Missing body" });
      const info = await backups.store(c.get("runtimeProject"), Readable.fromWeb(body as never), c.req.query("reason") ?? "manual");
      return c.json(info, 201);
    })
    .get("/backups/latest", async (c) => {
      const latest = await backups.latest(c.get("runtimeProject"));
      if (!latest) return c.json({ error: "No backup" }, 404);
      return new Response(Readable.toWeb(latest.body) as ReadableStream, {
        headers: { "content-type": "application/gzip", "x-backup-key": latest.info.key },
      });
    })
    .get("/schedules", async (c) => c.json<Schedule[]>(await schedules.list(c.get("runtimeProject"), c.req.query("owner") || undefined)))
    .post("/schedules", async (c) => {
      if (!c.get("project").features.scheduler) throw new HttpError(403, "errors.schedule.featureOff");
      const { owner, ...body } = parse(runtimeScheduleBody, await json(c));
      return c.json<Schedule>(await schedules.create(c.get("runtimeProject"), owner, body), 201);
    })
    .delete("/schedules/:id", async (c) => {
      const s = await schedules.get(c.get("runtimeProject"), c.req.param("id"));
      const owner = c.req.query("owner");
      if (owner && s.ownerId !== owner) throw new HttpError(404, "errors.schedule.notFound");
      await schedules.delete(c.get("runtimeProject"), s.id);
      return c.body(null, 204);
    });

  const app = new Hono()
    .use(telemetryMiddleware())
    .get("/health", (c) => c.json({ ok: true }))
    // Project logos, public like profile pictures (an <img> sends no token); the version in the URL is unguessable.
    .get("/auth/project-logos/:id/:version", async (c) => {
      const logo = await projects.logo(c.req.param("id"), c.req.param("version"));
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
      new Hono<Env>().use(fromGateway).route("/me", me).route("/admin", admin).route("/", project),
    );

  return app.onError((err, c) => {
    const locale = requestLocale(c.req.header("accept-language"));
    const mapped = errors(err) ?? err;
    if (mapped instanceof HTTPException) return c.json({ error: mapped.message }, mapped.status);
    const localized = errorResponse(mapped, locale);
    if (localized) return c.json(localized.body, localized.status);
    console.error(err);
    return c.json({ error: "Internal server error" }, 500);
  });
}
