import type { Client, Row } from "@libsql/client";
import { randomUUID } from "node:crypto";
import type { RunContext } from "../agent/context.ts";

export class ImageJobStore {
  constructor(private db: Client) {}
  async claim(ctx: RunContext, call: string, request: unknown) {
    const id = randomUUID();
    const r = await this.db.execute({ sql: `INSERT INTO image_jobs
      (id, thread_id, user_id, call_id, state, request, created_at) VALUES (?, ?, ?, ?, 'planning', ?, ?)
      ON CONFLICT(thread_id, user_id, call_id) DO NOTHING`,
      args: [id, ctx.thread_id, ctx.user_id, call, JSON.stringify(request), Date.now()] });
    const rows = await this.db.execute({ sql: "SELECT * FROM image_jobs WHERE thread_id=? AND user_id=? AND call_id=?", args: [ctx.thread_id, ctx.user_id, call] });
    return { fresh: r.rowsAffected === 1, row: rows.rows[0]! };
  }
  async get(ctx: RunContext, id: string) {
    return (await this.db.execute({ sql: "SELECT * FROM image_jobs WHERE id=? AND thread_id=? AND user_id=?", args: [id, ctx.thread_id, ctx.user_id] })).rows[0];
  }
  async history(ctx: RunContext) {
    return (await this.db.execute({ sql: "SELECT id,state,request,result,created_at FROM image_jobs WHERE thread_id=? AND user_id=? ORDER BY created_at DESC, rowid DESC LIMIT 50", args: [ctx.thread_id, ctx.user_id] })).rows;
  }
  async update(id: string, state: string, fields: { providerId?: string; context?: string; result?: string; request?: string } = {}) {
    await this.db.execute({ sql: "UPDATE image_jobs SET updated_at=?,state=?,provider_id=COALESCE(?,provider_id),context=COALESCE(?,context),result=COALESCE(?,result),request=COALESCE(?,request) WHERE id=?", args: [Date.now(), state, fields.providerId ?? null, fields.context ?? null, fields.result ?? null, fields.request ?? null, id] });
  }
  async lease(id: string, token: string, ttlMs: number) {
    const now = Date.now();
    return (await this.db.execute({ sql: "UPDATE image_jobs SET lease_token=?,lease_until=? WHERE id=? AND (lease_until<? OR lease_token=?)", args: [token, now + ttlMs, id, now, token] })).rowsAffected === 1;
  }
  async release(id: string, token: string) {
    await this.db.execute({ sql: "UPDATE image_jobs SET lease_token=NULL,lease_until=0 WHERE id=? AND lease_token=?", args: [id, token] });
  }
  async beginSubmission(id: string, context: unknown, maxAttempts: number, estimatedCost: number, maxCost?: number) {
    const r = await this.db.execute({ sql: `UPDATE image_jobs SET state='submitting',provider_id=NULL,context=?,attempts=attempts+1,estimated_cost=estimated_cost+?,updated_at=?
      WHERE id=? AND state IN ('planning','refining') AND attempts<? AND (? IS NULL OR estimated_cost+?<=?)`,
      args: [JSON.stringify(context), estimatedCost, Date.now(), id, maxAttempts, maxCost ?? null, estimatedCost, maxCost ?? null] });
    return r.rowsAffected === 1;
  }
  async beginRefinement(id: string, maxRefinements: number) {
    return (await this.db.execute({ sql: "UPDATE image_jobs SET state='refining',refinements=refinements+1 WHERE id=? AND state='running' AND refinements<?", args: [id, maxRefinements] })).rowsAffected === 1;
  }
  async catalog(provider: string) {
    return (await this.db.execute({ sql: "SELECT * FROM image_catalog WHERE provider=? AND verified_at>?", args: [provider, Date.now() - 24 * 60 * 60_000] })).rows;
  }
  async remember(provider: string, kind: string, id: string, metadata: unknown) {
    await this.db.execute({ sql: "INSERT INTO image_catalog(provider,kind,id,metadata,verified_at) VALUES (?,?,?,?,?) ON CONFLICT(provider,kind,id) DO UPDATE SET metadata=excluded.metadata,verified_at=excluded.verified_at", args: [provider, kind, id, JSON.stringify(metadata), Date.now()] });
  }
  async expired(before: number): Promise<Row[]> {
    return (await this.db.execute({ sql: "SELECT * FROM image_jobs WHERE created_at<? AND state IN ('completed','failed','cancelled') LIMIT 100", args: [before] })).rows;
  }
  async delete(id: string) { await this.db.execute({ sql: "DELETE FROM image_jobs WHERE id=?", args: [id] }); }

  async selection(ctx: RunContext) {
    return (await this.db.execute({ sql: "SELECT revision_id,selected_index FROM image_selections WHERE thread_id=? AND user_id=?", args: [ctx.thread_id, ctx.user_id] })).rows[0];
  }
  async select(ctx: RunContext, revision: string, index: number, expectedParent?: string) {
    await this.db.execute({ sql: `INSERT INTO image_selections(thread_id,user_id,revision_id,selected_index) VALUES (?,?,?,?)
      ON CONFLICT(thread_id,user_id) DO UPDATE SET revision_id=excluded.revision_id,selected_index=excluded.selected_index
      WHERE ? IS NULL OR image_selections.revision_id=?`, args: [ctx.thread_id, ctx.user_id, revision, index, expectedParent ?? null, expectedParent ?? null] });
  }

}
