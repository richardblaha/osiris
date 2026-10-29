import { tool, type StructuredToolInterface } from "@langchain/core/tools";
import type { Schedule, ScheduleInput } from "@osiris/shared";
import { z } from "zod";
import { getRunContext } from "@osiris/core/agent/context.ts";
import { FileError } from "@osiris/core/files/store.ts";
import { ServiceError } from "@osiris/platform/http.ts";

/** The scheduled tasks' API (control's, in the runtime). */
export interface ScheduleClient {
  createSchedule(owner: { id: string; name: string | null }, input: ScheduleInput): Promise<Schedule>;
  schedules(ownerId: string): Promise<Schedule[]>;
  deleteSchedule(ownerId: string, id: string): Promise<void>;
}

const when = (iso: string | null, timezone: string) =>
  iso ? new Date(iso).toLocaleString("cs-CZ", { timeZone: timezone, dateStyle: "medium", timeStyle: "short" }) : "—";

async function guarded(action: () => Promise<string>): Promise<string> {
  try {
    return await action();
  } catch (err) {
    if (err instanceof ServiceError || err instanceof FileError) return `Nelze: ${err.message}`;
    return `Operace selhala: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** Tools that act through control: scheduled tasks (feature `scheduler`). */
export function schedulerTools(control: ScheduleClient, timezone: string): StructuredToolInterface[] {
  const scheduleTask = tool(
    ({ title, prompt, cron, run_at, delivery }, config) =>
      guarded(async () => {
        const ctx = getRunContext(config);
        const s = await control.createSchedule(
          { id: ctx.user_id, name: ctx.user_name ?? null },
          { title, prompt, cron: cron ?? null, runAt: run_at ?? null, timezone, delivery },
        );
        return `Naplánováno: „${s.title}“ (id ${s.id}), poprvé ${when(s.nextRunAt, s.timezone)}${s.cron ? `, opakování ${s.cron}` : ""}.`;
      }),
    {
      name: "schedule_task",
      description:
        "Naplánuje úkol, který asistent sám spustí v daný čas (jednou nebo opakovaně) jménem uživatele. Použij jen na výslovný " +
        "pokyn uživatele. Prompt piš jako samostatné zadání, které bude dávat smysl i bez této konverzace.",
      schema: z.object({
        title: z.string().trim().min(1).max(100).describe("Krátký název úkolu"),
        prompt: z.string().trim().min(1).max(4000).describe("Co má asistent v daný čas udělat"),
        cron: z.string().max(100).optional().describe(`Opakování jako cron (5 polí, časové pásmo ${timezone}), např. "0 7 * * 1-5" = všední dny v 7:00`),
        run_at: z.string().max(40).optional().describe("Jednorázové spuštění, ISO 8601 s časovou zónou, např. 2026-10-20T07:00:00+02:00"),
        delivery: z.enum(["web", "whatsapp"]).default("web").describe("Kam poslat výsledek"),
      }),
    },
  );

  const listSchedules = tool(
    (_args, config) =>
      guarded(async () => {
        const list = await control.schedules(getRunContext(config).user_id);
        if (!list.length) return "Uživatel nemá žádné plánované úlohy.";
        return list
          .map((s) => `- [${s.id}] ${s.title}: ${s.enabled ? `další spuštění ${when(s.nextRunAt, s.timezone)}` : "vypnuto"}${s.cron ? ` (cron ${s.cron})` : ""}`)
          .join("\n");
      }),
    { name: "list_schedules", description: "Vypíše plánované úlohy uživatele.", schema: z.object({}) },
  );

  const cancelSchedule = tool(
    ({ id }, config) =>
      guarded(async () => {
        await control.deleteSchedule(getRunContext(config).user_id, id);
        return "Úloha zrušena.";
      }),
    { name: "cancel_schedule", description: "Zruší plánovanou úlohu uživatele podle id.", schema: z.object({ id: z.string().min(1).max(100) }) },
  );

  return [scheduleTask, listSchedules, cancelSchedule];
}
