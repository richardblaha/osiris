import { Hono } from "hono";
import { z } from "zod";
import type { ThreadMessage } from "@osiris/shared";
import type { CallerVerifier } from "./caller.ts";
import { withResolution, type Alert, type AlertStore } from "./engine.ts";

/** An alert as the twin's API gets it: without its fingerprint, resolved by now. */
export type AlertView = Omit<Alert, "fingerprint">;
const view = ({ fingerprint: _, ...a }: Alert, now: number, resolveMs: number): AlertView => withResolution({ fingerprint: "", ...a }, now, resolveMs);

/**
 * The alerts service's API, for the digital twin only (its ServiceAccount's token, checked by `caller`): the alerts,
 * newest first (of one cluster), one alert, and the conversation that investigated it, read from Osiris as the
 * service's own account (the twin never holds that account's credentials).
 */
export function alertsApp(deps: { store: AlertStore; caller: CallerVerifier; messages: (thread: string) => Promise<ThreadMessage[]>; resolveMs: number; now?: () => number }) {
  const now = () => deps.now?.() ?? Date.now();
  const query = z.object({ cluster: z.string().max(100).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) });
  return new Hono()
    .get("/healthz", (c) => c.json({ ok: true }))
    // Everything else only for the digital twin.
    .use("*", async (c, next) => {
      const token = /^Bearer (.+)$/i.exec(c.req.header("authorization") ?? "")?.[1];
      try {
        if (!token) throw new Error("No token");
        await deps.caller.verify(token);
      } catch {
        return c.json({ error: "unauthorized" }, 401);
      }
      await next();
    })
    .get("/alerts", async (c) => {
      const q = query.safeParse(c.req.query());
      if (!q.success) return c.json({ error: "bad query" }, 400);
      // Read more than asked when filtering by cluster, so a busy other cluster doesn't crowd it out.
      const list = await deps.store.list(q.data.cluster ? Math.min(1000, q.data.limit * 5) : q.data.limit);
      const t = now();
      return c.json({ value: list.filter((a) => !q.data.cluster || a.cluster === q.data.cluster).slice(0, q.data.limit).map((a) => view(a, t, deps.resolveMs)) });
    })
    .get("/alerts/:id", async (c) => {
      const a = await deps.store.get(c.req.param("id"));
      return a ? c.json(view(a, now(), deps.resolveMs)) : c.json({ error: "not found" }, 404);
    })
    .get("/alerts/:id/messages", async (c) => {
      const a = await deps.store.get(c.req.param("id"));
      if (!a) return c.json({ error: "not found" }, 404);
      if (!a.thread) return c.json([]);
      try {
        return c.json(await deps.messages(a.thread));
      } catch (err) {
        console.error(`Reading alert ${a.id}'s conversation failed`, err);
        return c.json({ error: "Osiris is unavailable" }, 502);
      }
    });
}
