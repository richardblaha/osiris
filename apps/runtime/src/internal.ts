import { randomUUID } from "node:crypto";
import { HumanMessage } from "@langchain/core/messages";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { RunContext } from "@osiris/core/agent/context.ts";
import * as threads from "@osiris/core/repo/threads.ts";
import * as sessions from "@osiris/core/repo/whatsapp.ts";
import type { Tenant } from "@osiris/core/tenants/tenant.ts";
import type { InternalVerifier } from "@osiris/platform/internal-auth.ts";
import type { Activity } from "./activity.ts";
import { verifyCall, type AuthEnv } from "./auth.ts";

const scheduledRun = z.object({ title: z.string().min(1).max(100), prompt: z.string().min(1).max(4000), idempotencyKey: z.string().min(1).max(200) });
const whatsappMessage = z.object({ messageId: z.string().min(1).max(200), text: z.string().min(1).max(20_000) });

/** A run's stored answer, so a repeated request (lost lease, redelivery) doesn't run the agent twice. */
async function once(tenant: Tenant, key: string, work: () => Promise<{ threadId: string; reply: string }>) {
  const { rows } = await tenant.db.execute({ sql: "SELECT thread_id, reply FROM processed_runs WHERE key = ?", args: [key] });
  if (rows[0]) return { threadId: String(rows[0].thread_id), reply: String(rows[0].reply) };
  const result = await work();
  await tenant.db.execute({
    sql: "INSERT INTO processed_runs (key, thread_id, reply) VALUES (?, ?, ?) ON CONFLICT (key) DO NOTHING",
    args: [key, result.threadId, result.reply],
  });
  return result;
}

export function createInternalRoutes({
  tenant,
  verifier,
  activity,
  snapshot,
}: {
  tenant: Tenant;
  verifier: InternalVerifier;
  activity: Activity;
  snapshot: (reason: string) => Promise<{ key: string; bytes: number }>;
  activeRuns: Set<string>;
}) {
  const invoke = async (ctx: RunContext, text: string) => {
    const { messages } = await activity.track(() =>
      tenant.graph.invoke({ messages: [new HumanMessage(text)] }, { configurable: { ...ctx } }),
    );
    return messages.at(-1)?.text ?? "";
  };

  /** Control's calls on behalf of a user: the token names the user, their role and the channel. */
  const asUser = (call: AuthEnv["Variables"]["call"]) => {
    if (!call.user || !call.role || call.tenant !== tenant.id) throw new HTTPException(401, { message: "Unauthorized" });
    return { user: call.user, role: call.role, channel: call.channel ?? "web" };
  };

  return new Hono<AuthEnv>()
    .use(async (c, next) => {
      c.set("call", await verifyCall(verifier, tenant, c.req.header("authorization"), ["control", "operator"]));
      await next();
    })

    .get("/activity", (c) => c.json({ lastActivity: activity.lastActivity, activeRuns: activity.activeRuns, sleeping: activity.sleeping }))

    // Before sleeping (reason=sleep) the runtime stops taking requests, so nothing changes after the snapshot.
    .post("/snapshot", async (c) => {
      const reason = c.req.query("reason") ?? "manual";
      if (reason === "sleep") {
        if (activity.activeRuns > 0) return c.json({ error: "Runs in progress" }, 409);
        activity.sleeping = true;
      }
      try {
        return c.json(await snapshot(reason));
      } catch (err) {
        activity.sleeping = false;
        throw err;
      }
    })

    // A scheduled task (control): runs the prompt as its owner in a new thread, which shows in the owner's web chat.
    .post("/runs", async (c) => {
      const { user, role, channel } = asUser(c.get("call"));
      const body = scheduledRun.safeParse(await c.req.json());
      if (!body.success) throw new HTTPException(400, { message: z.prettifyError(body.error) });
      const { title, prompt, idempotencyKey } = body.data;
      return c.json(
        await once(tenant, `schedule:${idempotencyKey}`, async () => {
          const threadId = randomUUID();
          await threads.createThread(tenant.db, user.sub, threadId, "web");
          await threads.touchThread(tenant.db, threadId, `⏰ ${title}`);
          const reply = await invoke(
            { thread_id: threadId, tenant_id: tenant.id, user_id: user.sub, role, channel, user_name: user.name ?? undefined },
            `[Plánovaná úloha „${title}“, spuštěná automaticky bez přítomnosti uživatele. Udělej ji a výsledek shrň.]\n\n${prompt}`,
          );
          return { threadId, reply };
        }),
      );
    })

    // A WhatsApp message (control found the user and the tenant): runs in the user's WhatsApp thread.
    .post("/whatsapp/message", async (c) => {
      const { user, role } = asUser(c.get("call"));
      const body = whatsappMessage.safeParse(await c.req.json());
      if (!body.success) throw new HTTPException(400, { message: z.prettifyError(body.error) });
      const { messageId, text } = body.data;
      const { reply } = await once(tenant, `whatsapp:${messageId}`, async () => {
        const threadId = await whatsappThread(tenant, user.sub);
        await threads.touchThread(tenant.db, threadId, text);
        const answer = await invoke(
          { thread_id: threadId, tenant_id: tenant.id, user_id: user.sub, role, channel: "whatsapp", user_name: user.name ?? undefined },
          text,
        );
        return { threadId, reply: answer };
      });
      return c.json({ reply });
    })

    .post("/whatsapp/new-thread", async (c) => {
      const { user } = asUser(c.get("call"));
      await sessions.setThread(tenant.db, user.sub, null);
      return c.body(null, 204);
    });
}

/** The user's current WhatsApp thread, created if there is none (or it was deleted on the web). */
async function whatsappThread(tenant: Tenant, userId: string): Promise<string> {
  const session = await sessions.getSession(tenant.db, userId);
  if (session?.threadId && (await threads.ownsThread(tenant.db, userId, session.threadId))) return session.threadId;
  const id = randomUUID();
  await threads.createThread(tenant.db, userId, id, "whatsapp");
  await sessions.setThread(tenant.db, userId, id);
  return id;
}
