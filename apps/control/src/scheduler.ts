import { randomUUID } from "node:crypto";
import { CronExpressionParser } from "cron-parser";
import type { Schedule, ScheduleInput } from "@osiris/shared";
import { isUnreachable, ServiceError } from "@osiris/platform/http.ts";
import { projectAudience, type InternalSigner } from "@osiris/platform/internal-auth.ts";
import { run, type Db } from "@osiris/platform/rqlite.ts";
import type { RuntimeClient } from "@osiris/platform/runtime-client.ts";
import { isSystemAdmin } from "@osiris/platform/claims.ts";
import { configuredLocale, LocalizedError, translate } from "@osiris/platform/i18n.ts";
import { roleIn, userAccess, type ProjectStore } from "./projects.ts";
import type { UserDirectory } from "./users.ts";
import type { WhatsAppClient } from "./whatsapp/cloud-api.ts";
import type { Inbox } from "./whatsapp/inbox.ts";
import { phoneKey, PHONE_CLAIM } from "./whatsapp/phones.ts";

export const MIN_INTERVAL_MS = 15 * 60_000;
export const MAX_PER_USER = 20;
export const MAX_PER_PROJECT = 200;
/** A run more than this late (runtime down, control down) is skipped rather than done at an odd time. */
export const MISFIRE_MS = 60 * 60_000;
const MAX_ATTEMPTS = 3;
const LEASE_MS = 15 * 60_000;
/** WhatsApp lets a business message a user freely only within 24 hours of the user's last message. */
const WHATSAPP_WINDOW_MS = 24 * 60 * 60_000;

export class ScheduleError extends LocalizedError {}
export class ScheduleNotFoundError extends LocalizedError {}

/** A note stored with a schedule (shown in its detail), in the configured language. */
const note = (key: string) => translate(configuredLocale(), key);

interface Row {
  id: string;
  project_id: string;
  owner_id: string;
  owner_name: string | null;
  title: string;
  prompt: string;
  cron: string | null;
  run_at: number | null;
  timezone: string;
  delivery: string;
  enabled: number;
  next_run_at: number | null;
  attempts: number;
  last_run_at: number | null;
  last_status: string | null;
  last_error: string | null;
  last_thread_id: string | null;
}

const iso = (ms: number | null) => (ms == null ? null : new Date(Number(ms)).toISOString());

const toSchedule = (r: Row): Schedule => ({
  id: r.id,
  ownerId: r.owner_id,
  ownerName: r.owner_name,
  title: r.title,
  prompt: r.prompt,
  cron: r.cron,
  runAt: iso(r.run_at),
  timezone: r.timezone,
  delivery: r.delivery === "whatsapp" ? "whatsapp" : "web",
  enabled: !!Number(r.enabled),
  nextRunAt: iso(r.next_run_at),
  lastRunAt: iso(r.last_run_at),
  lastStatus: (r.last_status as Schedule["lastStatus"]) ?? null,
  lastError: r.last_error,
  lastThreadId: r.last_thread_id,
});

/** The next time a cron expression fires after `after`, in the schedule's time zone. */
export function nextCron(cron: string, timezone: string, after: number): number {
  return CronExpressionParser.parse(cron, { currentDate: new Date(after), tz: timezone, strict: false }).next().getTime();
}

/** Checks a cron expression: 5 fields, valid, and not firing more often than every 15 minutes. */
export function checkCron(cron: string, timezone: string, now = Date.now()) {
  if (cron.trim().split(/\s+/).length !== 5) throw new ScheduleError("errors.schedule.cronFields");
  let times: number[];
  try {
    const it = CronExpressionParser.parse(cron, { currentDate: new Date(now), tz: timezone });
    times = Array.from({ length: 5 }, () => it.next().getTime());
  } catch (err) {
    throw new ScheduleError("errors.schedule.cronInvalid", { detail: (err as Error).message });
  }
  for (let i = 1; i < times.length; i++) {
    if (times[i]! - times[i - 1]! < MIN_INTERVAL_MS) throw new ScheduleError("errors.schedule.tooOften", { minutes: MIN_INTERVAL_MS / 60_000 });
  }
}

function checkTimezone(tz: string) {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
  } catch {
    throw new ScheduleError("errors.schedule.timezone", { timezone: tz });
  }
}

/** Scheduled tasks in the central database; any control replica may run them. */
export class ScheduleStore {
  constructor(
    private readonly db: Db,
    private readonly defaultTimezone: string,
  ) {}

  async list(projectId: string, ownerId?: string): Promise<Schedule[]> {
    const rows = ownerId
      ? await this.db.query<Row>("SELECT * FROM schedules WHERE project_id = ? AND owner_id = ? ORDER BY created_at", [projectId, ownerId])
      : await this.db.query<Row>("SELECT * FROM schedules WHERE project_id = ? ORDER BY created_at", [projectId]);
    return rows.map(toSchedule);
  }

  async get(projectId: string, id: string): Promise<Schedule> {
    const [row] = await this.db.query<Row>("SELECT * FROM schedules WHERE project_id = ? AND id = ?", [projectId, id], { fresh: true });
    if (!row) throw new ScheduleNotFoundError("errors.schedule.notFound");
    return toSchedule(row);
  }

  private timing(input: { cron?: string | null; runAt?: string | null; timezone: string }, now: number) {
    checkTimezone(input.timezone);
    if (input.cron) {
      checkCron(input.cron, input.timezone, now);
      return { cron: input.cron.trim(), runAt: null, next: nextCron(input.cron, input.timezone, now) };
    }
    if (!input.runAt) throw new ScheduleError("errors.schedule.timingMissing");
    const at = Date.parse(input.runAt);
    if (Number.isNaN(at)) throw new ScheduleError("errors.schedule.runAtInvalid");
    if (at < now - 60_000) throw new ScheduleError("errors.schedule.runAtPast");
    return { cron: null, runAt: at, next: at };
  }

  async create(projectId: string, owner: { id: string; name: string | null }, input: ScheduleInput, now = Date.now()): Promise<Schedule> {
    const timezone = input.timezone ?? this.defaultTimezone;
    const t = this.timing({ ...input, timezone }, now);
    const [counts] = await this.db.query<{ mine: number; total: number; quotas: string | null }>(
      `SELECT SUM(owner_id = ?) AS mine, COUNT(*) AS total, (SELECT quotas FROM projects WHERE id = ?) AS quotas
       FROM schedules WHERE project_id = ?`,
      [owner.id, projectId, projectId],
      { fresh: true },
    );
    // The project's quota (set by a system admin) or the built-in ceiling.
    const max = (JSON.parse(counts?.quotas ?? "{}") as { schedules?: number | null }).schedules ?? MAX_PER_PROJECT;
    if (Number(counts?.mine ?? 0) >= MAX_PER_USER) throw new ScheduleError("errors.schedule.userLimit", { count: MAX_PER_USER });
    if (Number(counts?.total ?? 0) >= max) throw new ScheduleError("errors.schedule.projectLimit", { count: max });
    const id = randomUUID();
    await this.db.execute([
      run(
        `INSERT INTO schedules (id, project_id, owner_id, owner_name, title, prompt, cron, run_at, timezone, delivery, enabled, next_run_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        projectId,
        owner.id,
        owner.name,
        input.title,
        input.prompt,
        t.cron,
        t.runAt,
        timezone,
        input.delivery ?? "web",
        input.enabled === false ? 0 : 1,
        t.next,
        now,
        now,
      ),
    ]);
    return this.get(projectId, id);
  }

  async update(projectId: string, id: string, input: Partial<ScheduleInput>, now = Date.now()): Promise<Schedule> {
    const current = await this.get(projectId, id);
    const timezone = input.timezone ?? current.timezone;
    const timingChanged = input.cron !== undefined || input.runAt !== undefined || input.timezone !== undefined || input.enabled === true;
    const t = timingChanged
      ? this.timing({ cron: input.cron !== undefined ? input.cron : current.cron, runAt: input.runAt !== undefined ? input.runAt : current.runAt, timezone }, now)
      : null;
    await this.db.execute([
      run(
        `UPDATE schedules SET title = ?, prompt = ?, delivery = ?, enabled = ?, timezone = ?, updated_at = ?,
           cron = COALESCE(?, cron), run_at = CASE WHEN ? THEN ? ELSE run_at END,
           next_run_at = CASE WHEN ? THEN ? ELSE next_run_at END, attempts = CASE WHEN ? THEN 0 ELSE attempts END
         WHERE project_id = ? AND id = ?`,
        input.title ?? current.title,
        input.prompt ?? current.prompt,
        input.delivery ?? current.delivery,
        (input.enabled ?? current.enabled) ? 1 : 0,
        timezone,
        now,
        t ? t.cron : null,
        t ? 1 : 0,
        t ? t.runAt : null,
        t ? 1 : 0,
        t ? t.next : null,
        t ? 1 : 0,
        projectId,
        id,
      ),
      // Switching from cron to a one-off clears the cron.
      ...(t && !t.cron ? [run("UPDATE schedules SET cron = NULL WHERE project_id = ? AND id = ?", projectId, id)] : []),
    ]);
    return this.get(projectId, id);
  }

  async delete(projectId: string, id: string) {
    const [r] = await this.db.execute([run("DELETE FROM schedules WHERE project_id = ? AND id = ?", projectId, id)]);
    if (!r?.rowsAffected) throw new ScheduleNotFoundError("errors.schedule.notFound");
  }

  /** Claims the next due task; its lease keeps other workers off until it's finished or the lease runs out. */
  async claim(now = Date.now()): Promise<(Schedule & { projectId: string; dueAt: number; attempts: number }) | null> {
    const next = "SELECT id FROM schedules WHERE enabled = 1 AND next_run_at <= ? AND (lease_until IS NULL OR lease_until < ?) ORDER BY next_run_at LIMIT 1";
    // Look before claiming: an UPDATE that changes nothing still grows rqlite's Raft log (see Inbox.claim).
    if (!(await this.db.query(next, [now, now])).length) return null;
    const claim = randomUUID();
    await this.db.execute([run(`UPDATE schedules SET claim = ?, lease_until = ? WHERE id = (${next})`, claim, now + LEASE_MS, now, now)]);
    const [row] = await this.db.query<Row>("SELECT * FROM schedules WHERE claim = ?", [claim], { fresh: true });
    return row ? { ...toSchedule(row), projectId: row.project_id, dueAt: Number(row.next_run_at), attempts: Number(row.attempts) } : null;
  }

  /** Records the run and moves on to the next occurrence (a one-off is switched off). */
  async finish(
    s: { id: string; projectId: string; cron: string | null; timezone: string; dueAt: number },
    result: { status: "done" | "failed" | "skipped"; threadId?: string | null; error?: string | null },
    now = Date.now(),
  ) {
    const next = s.cron ? nextCron(s.cron, s.timezone, Math.max(now, s.dueAt)) : null;
    await this.db.execute([
      run(
        "INSERT INTO schedule_runs (id, schedule_id, project_id, due_at, status, thread_id, error, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        randomUUID(),
        s.id,
        s.projectId,
        s.dueAt,
        result.status,
        result.threadId ?? null,
        result.error ?? null,
        now,
      ),
      run(
        `UPDATE schedules SET next_run_at = ?, enabled = CASE WHEN ? IS NULL THEN 0 ELSE enabled END, attempts = 0, claim = NULL,
           lease_until = NULL, last_run_at = ?, last_status = ?, last_error = ?, last_thread_id = COALESCE(?, last_thread_id)
         WHERE id = ?`,
        next,
        next,
        now,
        result.status,
        result.error ?? null,
        result.threadId ?? null,
        s.id,
      ),
      // Keep the last 50 runs per task.
      run(
        `DELETE FROM schedule_runs WHERE schedule_id = ? AND id NOT IN
           (SELECT id FROM schedule_runs WHERE schedule_id = ? ORDER BY finished_at DESC LIMIT 50)`,
        s.id,
        s.id,
      ),
    ]);
  }

  /** Tries the same occurrence again after `delayMs` (the lease doubles as "not before"). */
  async retry(id: string, delayMs: number, error: string, now = Date.now()) {
    await this.db.execute([
      run("UPDATE schedules SET attempts = attempts + 1, claim = NULL, lease_until = ?, last_error = ? WHERE id = ?", now + delayMs, error, id),
    ]);
  }

  async disable(id: string, error: string, now = Date.now()) {
    await this.db.execute([
      run("UPDATE schedules SET enabled = 0, claim = NULL, lease_until = NULL, last_status = 'failed', last_error = ?, last_run_at = ? WHERE id = ?", error, now, id),
    ]);
  }

  /** Tasks of a project that was removed, or of a user who left it, are deleted by the caller. */
  async deleteOwner(projectId: string, ownerId: string) {
    await this.db.execute([run("DELETE FROM schedules WHERE project_id = ? AND owner_id = ?", projectId, ownerId)]);
  }
}

/**
 * Runs due tasks: wakes the project's runtime, runs the prompt there as the task's owner (same tools and rights as the
 * owner in chat) and optionally sends the result over WhatsApp. Each occurrence carries an idempotency key, so a run
 * repeated after a lost lease is answered by the runtime from its record instead of running twice.
 */
export class SchedulerWorker {
  constructor(
    private readonly deps: {
      schedules: ScheduleStore;
      projects: ProjectStore;
      users: UserDirectory;
      runtimes: RuntimeClient;
      signer: InternalSigner;
      whatsapp?: { client: WhatsAppClient; inbox: Inbox };
    },
  ) {}

  async step(now = Date.now()): Promise<boolean> {
    const s = await this.deps.schedules.claim(now);
    if (!s) return false;
    if (now - s.dueAt > MISFIRE_MS) {
      await this.deps.schedules.finish(s, { status: "skipped", error: note("schedules.notes.missed") }, now);
      return true;
    }
    const project = await this.deps.projects.get(s.projectId);
    if (!project || project.status !== "active") {
      await this.deps.schedules.disable(s.id, note("schedules.notes.projectGone"), now);
      return true;
    }
    if (!project.features.scheduler) {
      await this.deps.schedules.finish(s, { status: "skipped", error: note("schedules.notes.featureOff") }, now);
      return true;
    }
    const owner = await this.deps.users.get(s.ownerId).catch(() => null);
    const role = owner && !owner.disabled ? (isSystemAdmin(userAccess(owner)) ? "admin" : roleIn(owner, s.projectId)) : null;
    if (!owner || !role) {
      await this.deps.schedules.disable(s.id, note("schedules.notes.ownerLeft"), now);
      return true;
    }

    try {
      const res = await this.deps.runtimes.request(s.projectId, "/internal/runs", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: await this.deps.signer.header(
            projectAudience(s.projectId),
            {
              user: { sub: owner.id, name: owner.name, email: owner.email, phone: owner.claims[PHONE_CLAIM] ?? null, picture: null },
              project: s.projectId,
              role,
              channel: s.delivery,
            },
            LEASE_MS / 1000,
          ),
        },
        body: JSON.stringify({ title: s.title, prompt: s.prompt, idempotencyKey: `${s.id}:${s.dueAt}` }),
        signal: AbortSignal.timeout(LEASE_MS - 60_000),
      });
      if (!res.ok) throw new ServiceError(`Runtime: ${res.status} ${(await res.text()).slice(0, 300)}`, res.status);
      const { threadId, reply } = (await res.json()) as { threadId: string; reply: string };
      const warning = s.delivery === "whatsapp" ? await this.sendWhatsApp(owner.claims[PHONE_CLAIM], s.title, reply, `t/${encodeURIComponent(s.projectId)}/chat/${encodeURIComponent(threadId)}`, now) : null;
      await this.deps.schedules.finish(s, { status: "done", threadId, error: warning }, now);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const retryable = isUnreachable(err) || (err instanceof ServiceError && err.status >= 500);
      if (retryable && s.attempts + 1 < MAX_ATTEMPTS) await this.deps.schedules.retry(s.id, 60_000 * 2 ** s.attempts, message, now);
      else await this.deps.schedules.finish(s, { status: "failed", error: message }, now);
    }
    return true;
  }

  /** Sends the result; returns a warning when WhatsApp can't be used (the result stays in the web thread). */
  private async sendWhatsApp(phone: string | undefined, title: string, reply: string, detailPath: string, now: number): Promise<string | null> {
    if (!this.deps.whatsapp) return note("schedules.notes.whatsappOff");
    if (!phone) return note("schedules.notes.noPhone");
    const last = await this.deps.whatsapp.inbox.lastPhoneNumberId(phoneKey(phone));
    if (last && now - last.at > WHATSAPP_WINDOW_MS && await this.deps.whatsapp.client.sendNotification(last.phoneNumberId, phoneKey(phone), title, detailPath)) return null;
    if (!last || now - last.at > WHATSAPP_WINDOW_MS) {
      return note("schedules.notes.whatsappWindow");
    }
    await this.deps.whatsapp.client.sendText(last.phoneNumberId, phoneKey(phone), `*${title}*\n\n${reply}`);
    return null;
  }
}
