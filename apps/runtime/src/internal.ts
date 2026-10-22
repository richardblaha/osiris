import { AttachmentError, attachmentInput, attachmentMessage } from "@osiris/core/agent/attachments.ts";
import { FILE_TYPES, fileType } from "@osiris/shared";
import { displayUserText, QuestionError } from "@osiris/core/agent/questions.ts";
import { randomUUID } from "node:crypto";
import { HumanMessage, ToolMessage, AIMessage } from "@langchain/core/messages";
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
const whatsappMessage = z.object({ messageId: z.string().min(1).max(200), text: z.string().min(1).max(20_000), attachment: z.object({ name: z.string().max(200), mime: z.string().max(100), data: z.string().max(28_000_000).regex(/^[A-Za-z0-9+/]*={0,2}$/) }).optional() });

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
  activeRuns,
}: {
  tenant: Tenant;
  verifier: InternalVerifier;
  activity: Activity;
  snapshot: (reason: string) => Promise<{ key: string; bytes: number }>;
  activeRuns: Set<string>;
}) {
  const invoke = async (ctx: RunContext, text: string) => {
    const key = `${tenant.id}/${ctx.thread_id}`;
    if (activeRuns.has(key)) throw new HTTPException(409, { message: "Běh už probíhá" });
    activeRuns.add(key);
    try {
      const decoded = attachmentInput(text);
      try { text = await tenant.questions.prepare(ctx.user_id, ctx.thread_id, decoded.text); }
      catch (err) { if (err instanceof QuestionError || err instanceof AttachmentError) throw new HTTPException(400, { message: err.message }); throw err; }
      const { messages } = await activity.track(async () => {
        const quota = await tenant.features.quotas();
        if (decoded.paths.length && (!(await tenant.features.get()).files || (quota.tokensPerMonth !== null && await tenant.usage.tokens() >= quota.tokensPerMonth) || (quota.tokensPerUserMonth !== null && await tenant.usage.tokens(Date.now(), { user: ctx.user_id }) >= quota.tokensPerUserMonth))) throw new HTTPException(403, { message: "Přílohy nejsou dostupné nebo je limit vyčerpán" });
        const input = decoded.paths.length ? await attachmentMessage(tenant.files, tenant.media, ctx.thread_id, text, decoded.paths, n => tenant.usage.add(n, Date.now(), { user: ctx.user_id })) : new HumanMessage({ content: text, additional_kwargs: { display_text: displayUserText(text) } });
        return tenant.graph.invoke({ messages: [input] }, { configurable: { ...ctx } });
      });
      const last = messages.at(-1);
      return last?.getType() === "ai" ? last.text : "";
    } finally { activeRuns.delete(key); }
  };

  const offeredFiles = async (threadId: string) => {
    const state = await tenant.graph.getState({ configurable: { thread_id: threadId } });
    const messages = state.values.messages ?? [];
    const start = messages.findLastIndex((m: unknown) => HumanMessage.isInstance(m));
    const calls = new Set(messages.slice(start).filter((m: unknown) => AIMessage.isInstance(m)).flatMap((m: AIMessage) => (m.tool_calls ?? []).filter(c => c.name === "send_chat_file").map(c => c.id)));
    return messages.slice(start).filter((m: unknown) => ToolMessage.isInstance(m)).flatMap((m: ToolMessage) => {
      if (!calls.has(m.tool_call_id)) return [];
      try { const v = JSON.parse(m.text); return v.file ? [v.file as { scope: "temp" | "tenant"; path: string; mime: string }] : []; } catch { return []; }
    }).slice(0, 5);
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
        let message = text;
        if (body.data.attachment) {
          if (!(await tenant.features.get()).files) throw new HTTPException(403, { message: "Soubory nejsou povolené" });
          const a = body.data.attachment;
          const mime = a.mime.split(";")[0]!;
          const ext = Object.entries(FILE_TYPES).find(([, type]) => type.mime === mime)?.[0];
          if (!ext) throw new HTTPException(400, { message: "Nepodporovaná příloha" });
          const filename = a.name.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/^\.+/, "").slice(-100) || "priloha";
          const path = `wa-${messageId.replace(/[^a-zA-Z0-9]/g, "").slice(-40)}-${fileType(filename)?.mime === mime ? filename : `${filename}.${ext}`}`;
          await tenant.files.write({ scope: "temp", threadId }, path, Buffer.from(a.data, "base64"));
          message = `@osiris-attachments:${JSON.stringify({ text, paths: [path] })}`;
        }
        const answer = await invoke(
          { thread_id: threadId, tenant_id: tenant.id, user_id: user.sub, role, channel: "whatsapp", user_name: user.name ?? undefined },
          message,
        );
        return { threadId, reply: answer };
      });
      const threadId = await whatsappThread(tenant, user.sub);
      return c.json({ reply, threadId, question: await tenant.questions.get(user.sub, threadId), files: await offeredFiles(threadId) });
    })

    .post("/whatsapp/file", async (c) => {
      const { user } = asUser(c.get("call"));
      if (!(await tenant.features.get()).files) throw new HTTPException(403);
      const { threadId, scope, path } = z.object({ threadId: z.string(), scope: z.enum(["tenant", "temp"]), path: z.string().max(300) }).parse(await c.req.json());
      if (!(await threads.ownsThread(tenant.db, user.sub, threadId)) || !(await offeredFiles(threadId)).some((f: { scope: string; path: string }) => f.scope === scope && f.path === path)) throw new HTTPException(404);
      const file = await tenant.files.read(scope === "temp" ? { scope, threadId } : { scope }, path);
      if (file.data.length > 20 * 1024 * 1024) throw new HTTPException(413);
      return c.json({ data: file.data.toString("base64"), name: path.split("/").at(-1), mime: fileType(path)!.mime });
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
