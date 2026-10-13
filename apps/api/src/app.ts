import { randomUUID } from "node:crypto";
import type { MeResponse, Skill } from "@osiris/shared";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { SKILL_NAME } from "./agent/skills.ts";
import { streamRun, toThreadMessages } from "./agent/run.ts";
import { authMiddleware, tenantMiddleware, type AuthEnv, type RequestContext } from "./auth/middleware.ts";
import type { TokenVerifier } from "./auth/oidc.ts";
import * as threads from "./repo/threads.ts";
import type { TenantRegistry } from "./tenants/registry.ts";

export interface AppDeps {
  verifier: TokenVerifier;
  tenants: TenantRegistry;
  corsOrigin: string;
  /** In production the API also serves the built web app from `dir`, plus its runtime config at `/config.js`. */
  web?: { dir: string; oidcAuthority?: string; oidcClientId?: string };
}

const runBody = z.object({ message: z.string().trim().min(1).max(20_000) });
const documentBody = z.object({ title: z.string().trim().min(1).max(200), content: z.string().min(1).max(500_000) });
const skillBody = z.object({
  description: z.string().trim().min(1).max(500),
  instructions: z.string().trim().min(1).max(50_000),
});
const memoryBody = z.object({ content: z.string().trim().min(1).max(500), shared: z.boolean().default(false) });

export function createApp({ verifier, tenants, corsOrigin, web }: AppDeps) {
  // Guards against two concurrent runs on one thread. In-process only: needs a shared lock once the API runs on several replicas.
  const activeRuns = new Set<string>();

  const requireThread = async ({ tenant, user }: RequestContext, id: string) => {
    if (!(await threads.ownsThread(tenant.db, user.sub, id))) throw new HTTPException(404, { message: "Thread not found" });
  };
  const requireAdmin = (ctx: RequestContext) => {
    if (ctx.role !== "admin") throw new HTTPException(403, { message: "Requires admin role" });
  };
  const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
    const r = schema.safeParse(value);
    if (!r.success) throw new HTTPException(400, { message: z.prettifyError(r.error) });
    return r.data;
  };
  const skillName = (name: string) => {
    if (!SKILL_NAME.test(name)) throw new HTTPException(400, { message: "Skill name must be lowercase-kebab-case" });
    return name;
  };

  const api = new Hono<AuthEnv>()
    .use(authMiddleware(verifier))

    // Before tenantMiddleware: the client calls this to learn which tenants it can pick.
    .get("/me", async (c) => {
      const { user, memberships } = c.get("auth");
      return c.json<MeResponse>({
        user: { id: user.sub, email: user.email, name: user.name, phone: user.phone },
        tenants: memberships.map((m) => ({ id: m.tenantId, name: m.tenantId, role: m.role })),
      });
    })

    .use(tenantMiddleware(tenants))

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
          const runCtx = { thread_id: id, tenant_id: tenant.id, user_id: user.sub, role, channel: "web" as const };
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

    .get("/knowledge/documents", async (c) => c.json(await c.get("ctx").tenant.knowledge.listDocuments()))

    .post("/knowledge/documents", async (c) => {
      const ctx = c.get("ctx");
      requireAdmin(ctx);
      const { title, content } = parse(documentBody, await c.req.json());
      return c.json(await ctx.tenant.knowledge.addDocument(title, content), 201);
    })

    .delete("/knowledge/documents/:id", async (c) => {
      const ctx = c.get("ctx");
      requireAdmin(ctx);
      if (!(await ctx.tenant.knowledge.deleteDocument(c.req.param("id")))) {
        throw new HTTPException(404, { message: "Document not found" });
      }
      return c.body(null, 204);
    })

    .get("/skills", async (c) => c.json(await c.get("ctx").tenant.skills.list()))

    .get("/skills/:name", async (c) => {
      const skill = await c.get("ctx").tenant.skills.get(c.req.param("name"));
      if (!skill) throw new HTTPException(404, { message: "Skill not found" });
      return c.json<Skill>(skill);
    })

    .put("/skills/:name", async (c) => {
      const ctx = c.get("ctx");
      requireAdmin(ctx);
      const name = skillName(c.req.param("name"));
      await ctx.tenant.skills.put({ name, ...parse(skillBody, await c.req.json()) });
      return c.json<Skill>((await ctx.tenant.skills.get(name))!);
    })

    .delete("/skills/:name", async (c) => {
      const ctx = c.get("ctx");
      requireAdmin(ctx);
      if (!(await ctx.tenant.skills.delete(c.req.param("name")))) {
        throw new HTTPException(404, { message: "Tenant skill not found" });
      }
      return c.body(null, 204);
    })

    .get("/memories", async (c) => {
      const { tenant, user } = c.get("ctx");
      return c.json(await tenant.memory.list(user.sub, 1000));
    })

    .post("/memories", async (c) => {
      const ctx = c.get("ctx");
      const { content, shared } = parse(memoryBody, await c.req.json());
      if (shared) requireAdmin(ctx);
      return c.json(await ctx.tenant.memory.add(ctx.user.sub, content, shared), 201);
    })

    .delete("/memories/:id", async (c) => {
      const { tenant, user, role } = c.get("ctx");
      if (!(await tenant.memory.delete(c.req.param("id"), user.sub, role === "admin"))) {
        throw new HTTPException(404, { message: "Memory not found" });
      }
      return c.body(null, 204);
    });

  const app = new Hono()
    .use("/api/*", cors({ origin: corsOrigin, allowHeaders: ["authorization", "content-type", "x-tenant-id"] }))
    .get("/health", (c) => c.json({ ok: true }))
    .route("/api", api)
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
