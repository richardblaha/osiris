import { createHash } from "node:crypto";
import type { RunContext } from "@osiris/core/agent/context.ts";
import { idName, type Records } from "@osiris/core/projects/records.ts";

/** An image job as it was a database row: snake_case fields, JSON kept as strings. */
export interface ImageJob {
  id: string;
  thread_id: string;
  user_id: string;
  call_id: string;
  state: string;
  request: string;
  provider_id: string | null;
  context: string | null;
  result: string | null;
  created_at: number;
  updated_at: number;
  attempts: number;
  refinements: number;
  estimated_cost: number;
  lease_token: string | null;
  lease_until: number;
  [key: string]: unknown;
}

type CatalogEntry = { provider: string; kind: string; id: string; metadata: string; verified_at: number };

const DIR = "private/images";
const jobFile = (id: string) => `${DIR}/jobs/${id}.json`;
/** One job per tool call: its id comes from the thread, the user and the call. */
const jobId = (thread: string, user: string, call: string) => createHash("sha256").update(`${thread}\n${user}\n${call}`).digest("hex").slice(0, 32);
const selectionFile = (ctx: RunContext) => `${DIR}/selections/${idName(`${ctx.thread_id}\n${ctx.user_id}`)}.json`;

// ponytail: history and expiry read every job file; fine for the images a project makes, an index if that grows.
export class ImageJobStore {
  constructor(private records: Records) {}

  private read(id: string) {
    return /^[0-9a-f]{32}$/.test(id) ? this.records.read<ImageJob>(jobFile(id)) : Promise.resolve(undefined);
  }

  /** Changes a job under its lock when `when` holds; true when it changed. */
  private change(id: string, when: (job: ImageJob) => boolean, change: (job: ImageJob) => Partial<ImageJob>): Promise<boolean> {
    return this.records.lock(jobFile(id), async () => {
      const job = await this.read(id);
      if (!job || !when(job)) return false;
      await this.records.write(jobFile(id), { ...job, ...change(job) });
      return true;
    });
  }

  private async jobs(): Promise<ImageJob[]> {
    return (await this.records.all<ImageJob>(`${DIR}/jobs`)).map((r) => r.value);
  }

  async claim(ctx: RunContext, call: string, request: unknown) {
    const id = jobId(ctx.thread_id, ctx.user_id, call);
    return this.records.lock(jobFile(id), async () => {
      const existing = await this.read(id);
      if (existing) return { fresh: false, row: existing };
      const row: ImageJob = {
        id, thread_id: ctx.thread_id, user_id: ctx.user_id, call_id: call, state: "planning", request: JSON.stringify(request),
        provider_id: null, context: null, result: null, created_at: Date.now(), updated_at: 0,
        attempts: 0, refinements: 0, estimated_cost: 0, lease_token: null, lease_until: 0,
      };
      await this.records.write(jobFile(id), row);
      return { fresh: true, row };
    });
  }
  async get(ctx: RunContext, id: string) {
    const job = await this.read(id);
    return job && job.thread_id === ctx.thread_id && job.user_id === ctx.user_id ? job : undefined;
  }
  async history(ctx: RunContext) {
    return (await this.jobs())
      .filter((j) => j.thread_id === ctx.thread_id && j.user_id === ctx.user_id)
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, 50);
  }
  async update(id: string, state: string, fields: { providerId?: string; context?: string; result?: string; request?: string } = {}) {
    await this.change(id, () => true, (j) => ({
      updated_at: Date.now(), state,
      provider_id: fields.providerId ?? j.provider_id, context: fields.context ?? j.context, result: fields.result ?? j.result, request: fields.request ?? j.request,
    }));
  }
  async lease(id: string, token: string, ttlMs: number) {
    const now = Date.now();
    return this.change(id, (j) => j.lease_until < now || j.lease_token === token, () => ({ lease_token: token, lease_until: now + ttlMs }));
  }
  async release(id: string, token: string) {
    await this.change(id, (j) => j.lease_token === token, () => ({ lease_token: null, lease_until: 0 }));
  }
  async beginSubmission(id: string, context: unknown, maxAttempts: number, estimatedCost: number, maxCost?: number) {
    return this.change(
      id,
      (j) => ["planning", "refining"].includes(j.state) && j.attempts < maxAttempts && (maxCost == null || j.estimated_cost + estimatedCost <= maxCost),
      (j) => ({ state: "submitting", provider_id: null, context: JSON.stringify(context), attempts: j.attempts + 1, estimated_cost: j.estimated_cost + estimatedCost, updated_at: Date.now() }),
    );
  }
  async beginRefinement(id: string, maxRefinements: number) {
    return this.change(id, (j) => j.state === "running" && j.refinements < maxRefinements, (j) => ({ state: "refining", refinements: j.refinements + 1 }));
  }
  async catalog(provider: string) {
    const all = (await this.records.read<CatalogEntry[]>(`${DIR}/catalog.json`)) ?? [];
    return all.filter((e) => e.provider === provider && e.verified_at > Date.now() - 24 * 60 * 60_000);
  }
  async remember(provider: string, kind: string, id: string, metadata: unknown) {
    await this.records.update<CatalogEntry[]>(`${DIR}/catalog.json`, (all = []) => [
      ...all.filter((e) => !(e.provider === provider && e.kind === kind && e.id === id)),
      { provider, kind, id, metadata: JSON.stringify(metadata), verified_at: Date.now() },
    ]);
  }
  async expired(before: number): Promise<ImageJob[]> {
    return (await this.jobs()).filter((j) => j.created_at < before && ["completed", "failed", "cancelled"].includes(j.state)).slice(0, 100);
  }
  async delete(id: string) {
    if (/^[0-9a-f]{32}$/.test(id)) await this.records.remove(jobFile(id));
  }

  async selection(ctx: RunContext) {
    return this.records.read<{ revision_id: string; selected_index: number }>(selectionFile(ctx));
  }
  async select(ctx: RunContext, revision: string, index: number, expectedParent?: string) {
    await this.records.lock(selectionFile(ctx), async () => {
      const current = await this.selection(ctx);
      if (current && expectedParent != null && current.revision_id !== expectedParent) return;
      await this.records.write(selectionFile(ctx), { revision_id: revision, selected_index: index });
    });
  }
}
