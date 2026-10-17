import type { Schedule, ScheduleInput } from "@osiris/shared";
import { useEffect, useState, type FormEvent } from "react";
import { api } from "./api.ts";
import { attempt, ErrorNotice, Field } from "./Scope.tsx";

const PRESETS: { label: string; cron: string }[] = [
  { label: "každý všední den v 7:00", cron: "0 7 * * 1-5" },
  { label: "každý den v 7:00", cron: "0 7 * * *" },
  { label: "každé pondělí v 8:00", cron: "0 8 * * 1" },
  { label: "každý pátek v 15:00", cron: "0 15 * * 5" },
  { label: "1. den v měsíci v 8:00", cron: "0 8 1 * *" },
];

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("cs-CZ", { dateStyle: "medium", timeStyle: "short" }) : "—");
const describe = (s: Schedule) => (s.cron ? (PRESETS.find((p) => p.cron === s.cron)?.label ?? `cron ${s.cron}`) : `jednou ${when(s.runAt)}`);
const STATUS: Record<NonNullable<Schedule["lastStatus"]>, string> = { done: "hotovo", failed: "selhalo", skipped: "vynecháno" };

type Draft = { title: string; prompt: string; mode: "cron" | "once"; cron: string; runAt: string; delivery: "web" | "whatsapp"; enabled: boolean };
const empty: Draft = { title: "", prompt: "", mode: "cron", cron: PRESETS[0]!.cron, runAt: "", delivery: "web", enabled: true };

const toDraft = (s: Schedule): Draft => ({
  title: s.title,
  prompt: s.prompt,
  mode: s.cron ? "cron" : "once",
  cron: s.cron ?? PRESETS[0]!.cron,
  // datetime-local wants local time without a zone.
  runAt: s.runAt ? new Date(new Date(s.runAt).getTime() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : "",
  delivery: s.delivery,
  enabled: s.enabled,
});

/** Tasks the assistant runs on its own at set times, as their owner; each run's result is a chat thread. */
export function Schedules({ isAdmin, onOpenThread }: { isAdmin: boolean; onOpenThread: (id: string) => void }) {
  const [all, setAll] = useState(false);
  const [list, setList] = useState<Schedule[]>();
  const [editing, setEditing] = useState<Schedule | "new" | null>(null);
  const [draft, setDraft] = useState<Draft>(empty);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const load = () => api.schedules(all).then(setList, (e: Error) => setError(e.message));
  useEffect(() => void load(), [all]);

  const open = (s: Schedule | "new") => {
    setEditing(s);
    setDraft(s === "new" ? empty : toDraft(s));
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const input: ScheduleInput = {
      title: draft.title,
      prompt: draft.prompt,
      cron: draft.mode === "cron" ? draft.cron : null,
      runAt: draft.mode === "once" ? new Date(draft.runAt).toISOString() : null,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      delivery: draft.delivery,
      enabled: draft.enabled,
    };
    void attempt(setBusy, setError, async () => {
      if (editing === "new") await api.createSchedule(input);
      else if (editing) await api.updateSchedule(editing.id, input);
      setEditing(null);
      await load();
    });
  };

  const act = (action: () => Promise<unknown>) => attempt(setBusy, setError, async () => (await action(), await load()));

  return (
    <div className="detail max-w-4xl">
      <div className="flex items-center gap-3">
        <h1 className="flex-1 text-lg font-semibold">Plánované úlohy</h1>
        {isAdmin && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> všech uživatelů
          </label>
        )}
        <button onClick={() => open("new")} className="btn-primary text-sm">
          Nová úloha
        </button>
      </div>
      <p className="mt-1 text-sm text-fg-secondary">
        Asistent úlohu spustí sám v nastavený čas, s tvými oprávněními. Výsledek najdeš jako novou konverzaci, případně i ve WhatsAppu.
        Úlohu můžeš zadat i v chatu, např. „každé ráno v 7 mi shrň dnešní zakázky“.
      </p>

      {editing && (
        <form onSubmit={submit} className="notice mt-4 space-y-3 p-3">
          <Field label="Název">
            <input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} required maxLength={100} className="field" />
          </Field>
          <Field label="Co má asistent udělat">
            <textarea value={draft.prompt} onChange={(e) => setDraft({ ...draft, prompt: e.target.value })} required maxLength={4000} rows={4} className="field" />
          </Field>
          <div className="flex flex-wrap gap-3">
            <Field label="Kdy">
              <select value={draft.mode} onChange={(e) => setDraft({ ...draft, mode: e.target.value as Draft["mode"] })} className="field w-auto">
                <option value="cron">opakovaně</option>
                <option value="once">jednou</option>
              </select>
            </Field>
            {draft.mode === "cron" ? (
              <>
                <Field label="Opakování">
                  <select
                    value={PRESETS.some((p) => p.cron === draft.cron) ? draft.cron : "custom"}
                    onChange={(e) => setDraft({ ...draft, cron: e.target.value === "custom" ? "" : e.target.value })}
                    className="field w-auto"
                  >
                    {PRESETS.map((p) => (
                      <option key={p.cron} value={p.cron}>
                        {p.label}
                      </option>
                    ))}
                    <option value="custom">vlastní (cron)</option>
                  </select>
                </Field>
                {!PRESETS.some((p) => p.cron === draft.cron) && (
                  <Field label="Cron (min hod den měsíc den-týdne)">
                    <input value={draft.cron} onChange={(e) => setDraft({ ...draft, cron: e.target.value })} placeholder="30 6 * * 1-5" required className="field w-auto" />
                  </Field>
                )}
              </>
            ) : (
              <Field label="Datum a čas">
                <input type="datetime-local" value={draft.runAt} onChange={(e) => setDraft({ ...draft, runAt: e.target.value })} required className="field w-auto" />
              </Field>
            )}
            <Field label="Výsledek poslat">
              <select value={draft.delivery} onChange={(e) => setDraft({ ...draft, delivery: e.target.value as Draft["delivery"] })} className="field w-auto">
                <option value="web">jen do chatu</option>
                <option value="whatsapp">i na WhatsApp</option>
              </select>
            </Field>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} /> zapnutá
          </label>
          <div className="flex gap-2">
            <button disabled={busy} className="btn-primary">
              {busy ? "Ukládám…" : "Uložit"}
            </button>
            <button type="button" onClick={() => setEditing(null)} className="btn-secondary">
              Zrušit
            </button>
          </div>
        </form>
      )}
      <ErrorNotice error={error} />

      <ul className="mt-4 divide-y divide-line">
        {list?.map((s) => (
          <li key={s.id} className="py-3 text-sm">
            <div className="flex flex-wrap items-baseline gap-x-3">
              <span className={`font-medium ${s.enabled ? "" : "text-fg-muted line-through"}`}>{s.title}</span>
              <span className="text-fg-secondary">{describe(s)}</span>
              {s.delivery === "whatsapp" && <span className="badge">WhatsApp</span>}
              {all && s.ownerName && <span className="badge">{s.ownerName}</span>}
            </div>
            <p className="mt-0.5 text-xs text-fg-muted">
              další spuštění {s.enabled ? when(s.nextRunAt) : "—"}
              {s.lastRunAt && ` · naposledy ${when(s.lastRunAt)} (${s.lastStatus ? STATUS[s.lastStatus] : "?"})`}
            </p>
            {s.lastError && <p className="mt-0.5 text-xs text-error">{s.lastError}</p>}
            <div className="mt-1 flex gap-3">
              {s.lastThreadId && (
                <button onClick={() => onOpenThread(s.lastThreadId!)} className="btn-link">
                  Poslední výsledek
                </button>
              )}
              <button onClick={() => void act(() => api.runSchedule(s.id))} disabled={busy} className="btn-link">
                Spustit teď
              </button>
              <button onClick={() => open(s)} className="btn-link">
                Upravit
              </button>
              <button onClick={() => window.confirm(`Smazat úlohu „${s.title}“?`) && void act(() => api.deleteSchedule(s.id))} className="btn-danger">
                Smazat
              </button>
            </div>
          </li>
        ))}
        {list && !list.length && <li className="py-3 text-sm text-fg-muted">Zatím žádné úlohy.</li>}
      </ul>
    </div>
  );
}
