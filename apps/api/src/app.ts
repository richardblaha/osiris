import { randomUUID } from "node:crypto";
import {
  FEATURES,
  type DirectoryUser,
  type Feature,
  type McpServer,
  type MeResponse,
  type Scope,
  type SecretSummary,
  type Skill,
  type TenantDetail,
  type TenantFeatures,
  type TenantInfo,
  type TenantSummary,
  type UserSettings,
} from "@osiris/shared";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { SKILL_NAME } from "./agent/skills.ts";
import { streamRun, toThreadMessages } from "./agent/run.ts";
import { authMiddleware, tenantMiddleware, type AuthEnv, type Authenticated, type RequestContext } from "./auth/middleware.ts";
import { TENANT_SLUG } from "./auth/tenants.ts";
import { TenantExistsError, TenantNotFoundError, type TenantDirectory } from "./tenants/directory.ts";
import type { TokenVerifier } from "./auth/oidc.ts";
import { MCP_SERVER_NAME, McpNameTakenError, mcpOwner } from "./mcp/store.ts";
import { UnsafeUrlError } from "./mcp/url.ts";
import * as threads from "./repo/threads.ts";
import { HOST_PATTERN, SECRET_NAME, SecretUseError } from "./vault/template.ts";
import { secretOwner } from "./vault/vault.ts";
import type { TenantRegistry } from "./tenants/registry.ts";
import { whatsappWebhook, type WhatsAppWebhookOptions } from "./whatsapp/webhook.ts";

export interface AppDeps {
  verifier: TokenVerifier;
  tenants: TenantRegistry;
  /** Which tenants exist and who is in them (PocketID groups in production). */
  directory: TenantDirectory;
  corsOrigin: string;
  /** In production the API also serves the built web app from `dir`, plus its runtime config at `/config.js`. */
  web?: { dir: string; oidcAuthority?: string; oidcClientId?: string };
  /** The WhatsApp channel; without it `/webhooks/whatsapp` answers 404. */
  whatsapp?: WhatsAppWebhookOptions;
}

const runBody = z.object({ message: z.string().trim().min(1).max(20_000) });
const scope = z.enum(["tenant", "personal"]).default("personal");
const documentBody = z.object({
  title: z.string().trim().min(1).max(200),
  content: z.string().min(1).max(500_000),
  scope,
});
const skillBody = z.object({
  description: z.string().trim().min(1).max(500),
  instructions: z.string().trim().min(1).max(50_000),
  scope,
});
const mcpServerBody = z.object({
  url: z.string().trim().min(1).max(2000),
  enabled: z.boolean().default(true),
  // Omitted = keep the stored headers. Values are secrets (tokens) and are never returned.
  headers: z
    .record(z.string().regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/, "Neplatný název hlavičky"), z.string().max(4000).regex(/^[^\r\n]*$/))
    .optional(),
  scope,
});
const settingsBody = z.object({
  address: z.enum(["auto", "ty", "vy"]),
  language: z.enum(["auto", "cs", "sk"]),
  signature: z.string().trim().max(1000),
  instructions: z.string().trim().max(4000),
});
const featuresBody = z.object(Object.fromEntries(FEATURES.map((f) => [f, z.boolean().optional()]))) as z.ZodType<Partial<TenantFeatures>>;
const tenantName = z.string().trim().min(1).max(100);
const createTenantBody = z.object({
  id: z.string().trim().max(40).regex(TENANT_SLUG, "Zkratka: malá písmena, číslice a pomlčky, nesmí končit na -admin"),
  name: tenantName,
  features: featuresBody.optional(),
});
const updateTenantBody = z.object({ name: tenantName.optional(), features: featuresBody.optional() });
const memberBody = z.object({ role: z.enum(["admin", "member"]) });
const memoryBody = z.object({ content: z.string().trim().min(1).max(500), scope });
const secretBody = z.object({
  // Omitted = keep the stored value (e.g. when only the hosts change). Never returned.
  value: z.string().min(1).max(10_000).optional(),
  allowedHosts: z
    .array(z.string().trim().toLowerCase().regex(HOST_PATTERN, "Neplatná doména (např. api.example.com nebo *.example.com)"))
    .min(1, "Zadej aspoň jednu povolenou doménu")
    .max(20),
  description: z.string().trim().max(300).default(""),
  scope,
});

/** Which settings pages need which feature. Secrets serve both http_request and MCP. */
const FEATURE_ROUTES: [string, Feature[]][] = [
  ["/knowledge", ["knowledge"]],
  ["/skills", ["skills"]],
  ["/memories", ["memory"]],
  ["/mcp-servers", ["mcp"]],
  ["/secrets", ["http", "mcp"]],
];

export function createApp({ verifier, tenants, directory, corsOrigin, web, whatsapp }: AppDeps) {
  // Guards against two concurrent runs on one thread. In-process only: needs a shared lock once the API runs on several replicas.
  const activeRuns = new Set<string>();

  const requireThread = async ({ tenant, user }: RequestContext, id: string) => {
    if (!(await threads.ownsThread(tenant.db, user.sub, id))) throw new HTTPException(404, { message: "Thread not found" });
  };
  const requireAdmin = (ctx: RequestContext) => {
    if (ctx.role !== "admin") throw new HTTPException(403, { message: "Requires admin role" });
  };
  /** Anyone may change their personal settings; tenant-wide ones need an admin. */
  const requireScope = (ctx: RequestContext, scope: Scope) => {
    if (scope === "tenant") requireAdmin(ctx);
  };
  const queryScope = (value: string | undefined): Scope => {
    if (value === undefined || value === "personal") return "personal";
    if (value === "tenant") return "tenant";
    throw new HTTPException(400, { message: "scope must be tenant or personal" });
  };
  const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
    const r = schema.safeParse(value);
    if (!r.success) throw new HTTPException(400, { message: z.prettifyError(r.error) });
    return r.data;
  };
  const checkMcpUrl = async ({ tenant }: RequestContext, url: string) => {
    try {
      await tenant.mcp.checkUrl(url);
    } catch (err) {
      if (err instanceof UnsafeUrlError || err instanceof SecretUseError) throw new HTTPException(400, { message: err.message });
      throw err;
    }
  };
  const requireSystemAdmin = (auth: Authenticated) => {
    if (!auth.systemAdmin) throw new HTTPException(403, { message: "Requires osiris-admin" });
  };
  /** Display names from the directory; if it's unavailable, the slugs. */
  const tenantNames = async () => {
    try {
      return new Map((await directory.list()).map((t) => [t.id, t.name]));
    } catch (err) {
      console.error("Tenant directory unavailable", err);
      return new Map<string, string>();
    }
  };
  /** A tenant from the directory, so a typo never creates a database. */
  const knownTenant = async (id: string): Promise<TenantSummary> => {
    const tenant = (await directory.list()).find((t) => t.id === id);
    if (!tenant) throw new HTTPException(404, { message: "Tenant not found" });
    return tenant;
  };
  const directoryErrors = async <T>(action: () => Promise<T>): Promise<T> => {
    try {
      return await action();
    } catch (err) {
      if (err instanceof TenantExistsError) throw new HTTPException(409, { message: "Tenant s touto zkratkou už existuje" });
      if (err instanceof TenantNotFoundError) throw new HTTPException(404, { message: "Tenant not found" });
      throw err;
    }
  };
  const skillName = (name: string) => {
    if (!SKILL_NAME.test(name)) throw new HTTPException(400, { message: "Skill name must be lowercase-kebab-case" });
    return name;
  };

  // System admins (group osiris-admin) manage tenants: create, rename, remove, features and members.
  const admin = new Hono<AuthEnv>()
    .use(async (c, next) => {
      requireSystemAdmin(c.get("auth"));
      await next();
    })

    .get("/tenants", async (c) => c.json<TenantSummary[]>(await directory.list()))

    .post("/tenants", async (c) => {
      const { id, name, features } = parse(createTenantBody, await c.req.json());
      await directoryErrors(() => directory.create(id, name));
      // Creates and migrates the database now, so a broken setup shows up here and not on the first login.
      const tenant = await tenants.get(id);
      if (features) await tenant.features.set(features);
      return c.json<TenantSummary>(await knownTenant(id), 201);
    })

    .get("/tenants/:id", async (c) => {
      const summary = await knownTenant(c.req.param("id"));
      const tenant = await tenants.get(summary.id);
      return c.json<TenantDetail>({
        ...summary,
        features: await tenant.features.get(),
        memberList: await directoryErrors(() => directory.members(summary.id)),
      });
    })

    .patch("/tenants/:id", async (c) => {
      const { id } = await knownTenant(c.req.param("id"));
      const { name, features } = parse(updateTenantBody, await c.req.json());
      if (name) await directoryErrors(() => directory.rename(id, name));
      if (features) {
        const tenant = await tenants.get(id);
        await tenant.features.set(features);
        // MCP tools are cached per owner; switching MCP should apply at once.
        tenant.mcp.invalidateAll();
      }
      return c.body(null, 204);
    })

    // Removes everyone's access (the PocketID groups) and archives the database.
    .delete("/tenants/:id", async (c) => {
      const { id } = await knownTenant(c.req.param("id"));
      await directoryErrors(() => directory.remove(id));
      await tenants.remove(id);
      return c.body(null, 204);
    })

    .put("/tenants/:id/members/:userId", async (c) => {
      const { id } = await knownTenant(c.req.param("id"));
      const { role } = parse(memberBody, await c.req.json());
      await directoryErrors(() => directory.setRole(id, c.req.param("userId"), role));
      return c.body(null, 204);
    })

    .delete("/tenants/:id/members/:userId", async (c) => {
      const { id } = await knownTenant(c.req.param("id"));
      await directoryErrors(() => directory.setRole(id, c.req.param("userId"), null));
      return c.body(null, 204);
    })

    .get("/users", async (c) => c.json<DirectoryUser[]>(await directory.users()));

  const api = new Hono<AuthEnv>()
    .use(authMiddleware(verifier, directory))

    // Before tenantMiddleware: the client calls this to learn which tenants it can pick.
    .get("/me", async (c) => {
      const { user, memberships, systemAdmin } = c.get("auth");
      const names = await tenantNames();
      return c.json<MeResponse>({
        user: { id: user.sub, email: user.email, name: user.name, phone: user.phone },
        systemAdmin,
        tenants: memberships.map((m) => ({ id: m.tenantId, name: names.get(m.tenantId) ?? m.tenantId, role: m.role })),
      });
    })

    .route("/admin", admin)

    .use(tenantMiddleware(tenants))

    .get("/tenant", async (c) => {
      const { tenant, role } = c.get("ctx");
      const names = await tenantNames();
      return c.json<TenantInfo>({ id: tenant.id, name: names.get(tenant.id) ?? tenant.id, role, features: await tenant.features.get() });
    })

    // Settings of a feature the tenant doesn't have are refused, not just hidden in the web app.
    .use(async (c, next) => {
      const route = FEATURE_ROUTES.find(([prefix]) => c.req.path === `/api${prefix}` || c.req.path.startsWith(`/api${prefix}/`));
      if (route) {
        const on = await c.get("ctx").tenant.features.get();
        if (!route[1].some((f) => on[f])) throw new HTTPException(403, { message: "Tato funkce není pro tenant povolená" });
      }
      await next();
    })

    .get("/threads", async (c) => {
      const { tenant, user } = c.get("ctx");
      return c.json(await threads.listThreads(tenant.db, user.sub));
    })

    .post("/threads", async (c) => {
      const { tenant, user } = c.get("ctx");
      const id = randomUUID();
      await threads.createThread(tenant.db, user.sub, id, "web");
      return c.json({ id }, 201);
    })

    .get("/threads/:id/messages", async (c) => {
      const ctx = c.get("ctx");
      const id = c.req.param("id");
      await requireThread(ctx, id);
      const state = await ctx.tenant.graph.getState({ configurable: { thread_id: id } });
      return c.json(toThreadMessages(state.values.messages ?? []));
    })

    .delete("/threads/:id", async (c) => {
      const ctx = c.get("ctx");
      const id = c.req.param("id");
      await requireThread(ctx, id);
      await ctx.tenant.checkpointer.deleteThread(id);
      await threads.deleteThread(ctx.tenant.db, id);
      return c.body(null, 204);
    })

    .post("/threads/:id/runs", async (c) => {
      const ctx = c.get("ctx");
      const { tenant, user, role } = ctx;
      const id = c.req.param("id");
      await requireThread(ctx, id);
      const { message } = parse(runBody, await c.req.json());
      const runKey = `${tenant.id}/${id}`;
      if (activeRuns.has(runKey)) throw new HTTPException(409, { message: "A run is already in progress for this thread" });

      activeRuns.add(runKey);
      await threads.touchThread(tenant.db, id, message);
      const abort = new AbortController();
      return streamSSE(c, async (sse) => {
        sse.onAbort(() => abort.abort());
        try {
          const runCtx = {
            thread_id: id,
            tenant_id: tenant.id,
            user_id: user.sub,
            role,
            channel: "web" as const,
            user_name: user.name ?? undefined,
          };
          for await (const event of streamRun(tenant.graph, runCtx, message, abort.signal)) {
            await sse.writeSSE({ data: JSON.stringify(event) });
          }
        } catch (err) {
          if (!abort.signal.aborted) {
            console.error("Run failed", { tenantId: tenant.id, threadId: id, err });
            await sse.writeSSE({ data: JSON.stringify({ type: "error", message: "Agent run failed" }) });
          }
        } finally {
          activeRuns.delete(runKey);
        }
      });
    })

    // Settings come in two scopes: `tenant` (everyone in the tenant, admins only) and `personal` (the caller only).

    .get("/knowledge/documents", async (c) => {
      const { tenant, user } = c.get("ctx");
      return c.json(await tenant.knowledge.listDocuments(user.sub));
    })

    .post("/knowledge/documents", async (c) => {
      const ctx = c.get("ctx");
      const { title, content, scope } = parse(documentBody, await c.req.json());
      requireScope(ctx, scope);
      return c.json(await ctx.tenant.knowledge.addDocument(title, content, scope, ctx.user.sub), 201);
    })

    .delete("/knowledge/documents/:id", async (c) => {
      const ctx = c.get("ctx");
      const scope = queryScope(c.req.query("scope"));
      requireScope(ctx, scope);
      if (!(await ctx.tenant.knowledge.deleteDocument(c.req.param("id"), scope, ctx.user.sub))) {
        throw new HTTPException(404, { message: "Document not found" });
      }
      return c.body(null, 204);
    })

    // `?scope=tenant` shows what the tenant has (tenant and bundled skills), without the caller's personal overrides.
    .get("/skills", async (c) => {
      const { tenant, user } = c.get("ctx");
      return c.json(await tenant.skills.list(queryScope(c.req.query("scope")) === "tenant" ? "" : user.sub));
    })

    .get("/skills/:name", async (c) => {
      const { tenant, user } = c.get("ctx");
      const viewer = queryScope(c.req.query("scope")) === "tenant" ? "" : user.sub;
      const skill = await tenant.skills.get(c.req.param("name"), viewer);
      if (!skill) throw new HTTPException(404, { message: "Skill not found" });
      return c.json<Skill>(skill);
    })

    .put("/skills/:name", async (c) => {
      const ctx = c.get("ctx");
      const name = skillName(c.req.param("name"));
      const { scope, ...skill } = parse(skillBody, await c.req.json());
      requireScope(ctx, scope);
      await ctx.tenant.skills.put({ name, ...skill }, scope, ctx.user.sub);
      return c.json<Skill>((await ctx.tenant.skills.get(name, ctx.user.sub))!);
    })

    .delete("/skills/:name", async (c) => {
      const ctx = c.get("ctx");
      const scope = queryScope(c.req.query("scope"));
      requireScope(ctx, scope);
      if (!(await ctx.tenant.skills.delete(c.req.param("name"), scope, ctx.user.sub))) {
        throw new HTTPException(404, { message: "Skill not found" });
      }
      return c.body(null, 204);
    })

    .get("/mcp-servers", async (c) => {
      const { tenant, user, role } = c.get("ctx");
      const servers = await tenant.mcpServers.list(user.sub, { showTenantUrls: role === "admin" });
      return c.json<McpServer[]>(
        servers.map((s) => ({
          ...s,
          status: s.enabled ? tenant.mcp.status(mcpOwner(s.scope, user.sub)).get(s.name) : undefined,
        })),
      );
    })

    .put("/mcp-servers/:name", async (c) => {
      const ctx = c.get("ctx");
      const name = c.req.param("name");
      if (!MCP_SERVER_NAME.test(name)) throw new HTTPException(400, { message: "Server name must be lowercase-kebab-case" });
      const { scope, ...body } = parse(mcpServerBody, await c.req.json());
      requireScope(ctx, scope);
      await checkMcpUrl(ctx, body.url);
      const owner = mcpOwner(scope, ctx.user.sub);
      try {
        await ctx.tenant.mcpServers.put(name, owner, body);
      } catch (err) {
        if (err instanceof McpNameTakenError) throw new HTTPException(409, { message: err.message });
        throw err;
      }
      ctx.tenant.mcp.invalidate(owner);
      return c.body(null, 204);
    })

    .delete("/mcp-servers/:name", async (c) => {
      const ctx = c.get("ctx");
      const scope = queryScope(c.req.query("scope"));
      requireScope(ctx, scope);
      const owner = mcpOwner(scope, ctx.user.sub);
      if (!(await ctx.tenant.mcpServers.delete(c.req.param("name"), owner))) {
        throw new HTTPException(404, { message: "MCP server not found" });
      }
      ctx.tenant.mcp.invalidate(owner);
      return c.body(null, 204);
    })

    // Connects once with the stored configuration and reports the tools (or the error).
    .post("/mcp-servers/:name/test", async (c) => {
      const ctx = c.get("ctx");
      const scope = queryScope(c.req.query("scope"));
      requireScope(ctx, scope);
      const owner = mcpOwner(scope, ctx.user.sub);
      const server = await ctx.tenant.mcpServers.get(c.req.param("name"), owner);
      if (!server) throw new HTTPException(404, { message: "MCP server not found" });
      return c.json(await ctx.tenant.mcp.test(server, owner));
    })

    .get("/settings", async (c) => {
      const { tenant, user } = c.get("ctx");
      return c.json<UserSettings>(await tenant.settings.get(user.sub));
    })

    .put("/settings", async (c) => {
      const { tenant, user } = c.get("ctx");
      const settings = parse(settingsBody, await c.req.json());
      await tenant.settings.put(user.sub, settings);
      return c.json<UserSettings>(settings);
    })

    .get("/memories", async (c) => {
      const { tenant, user } = c.get("ctx");
      return c.json(await tenant.memory.list(user.sub, 1000));
    })

    .post("/memories", async (c) => {
      const ctx = c.get("ctx");
      const { content, scope } = parse(memoryBody, await c.req.json());
      requireScope(ctx, scope);
      return c.json(await ctx.tenant.memory.add(ctx.user.sub, content, scope), 201);
    })

    .delete("/memories/:id", async (c) => {
      const ctx = c.get("ctx");
      const scope = queryScope(c.req.query("scope"));
      requireScope(ctx, scope);
      if (!(await ctx.tenant.memory.delete(c.req.param("id"), scope, ctx.user.sub))) {
        throw new HTTPException(404, { message: "Memory not found" });
      }
      return c.body(null, 204);
    })

    // Secrets are write-only: the list has names, hosts and descriptions, never values.
    .get("/secrets", async (c) => {
      const { tenant, user } = c.get("ctx");
      return c.json<SecretSummary[]>(await tenant.secrets.list(user.sub));
    })

    .put("/secrets/:name", async (c) => {
      const ctx = c.get("ctx");
      const name = c.req.param("name");
      if (!SECRET_NAME.test(name)) throw new HTTPException(400, { message: "Název musí být VELKÝMI_PÍSMENY (A-Z, 0-9, _)" });
      const { scope, ...body } = parse(secretBody, await c.req.json());
      requireScope(ctx, scope);
      try {
        await ctx.tenant.secrets.put(name, secretOwner(scope, ctx.user.sub), body);
      } catch (err) {
        if (err instanceof SecretUseError) throw new HTTPException(400, { message: err.message });
        throw err;
      }
      // MCP servers may use the secret: reconnect with the new value.
      ctx.tenant.mcp.invalidateAll();
      return c.body(null, 204);
    })

    .delete("/secrets/:name", async (c) => {
      const ctx = c.get("ctx");
      const scope = queryScope(c.req.query("scope"));
      requireScope(ctx, scope);
      if (!(await ctx.tenant.secrets.delete(c.req.param("name"), secretOwner(scope, ctx.user.sub)))) {
        throw new HTTPException(404, { message: "Secret not found" });
      }
      ctx.tenant.mcp.invalidateAll();
      return c.body(null, 204);
    });

  const app = new Hono()
    .use("/api/*", cors({ origin: corsOrigin, allowHeaders: ["authorization", "content-type", "x-tenant-id"] }))
    .get("/health", (c) => c.json({ ok: true }))
    .route("/api", api)
    // Registered even when off, so the SPA fallback doesn't answer Meta's verification with index.html.
    .route("/webhooks/whatsapp", whatsapp ? whatsappWebhook(whatsapp) : new Hono().all("/", (c) => c.text("WhatsApp is not configured", 404)))
    // Runtime config for the web client, so one image works with any PocketID client. Loaded before the app bundle.
    .get("/config.js", (c) => {
      const config = { oidcAuthority: web?.oidcAuthority, oidcClientId: web?.oidcClientId };
      c.header("cache-control", "no-cache");
      return c.body(`window.__OSIRIS_CONFIG__ = ${JSON.stringify(config)};\n`, 200, { "content-type": "text/javascript" });
    });

  if (web) {
    app
      .use("/assets/*", async (c, next) => {
        await next();
        // Vite puts a content hash in asset file names.
        if (c.res.ok) c.header("cache-control", "public, max-age=31536000, immutable");
      })
      .use("*", serveStatic({ root: web.dir }))
      // SPA fallback: client-side routes such as /callback get index.html.
      .get("*", serveStatic({ root: web.dir, path: "index.html" }));
  }

  return app.onError((err, c) => {
      if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
      console.error(err);
      return c.json({ error: "Internal server error" }, 500);
    });
}
