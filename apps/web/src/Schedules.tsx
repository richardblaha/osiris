import type { Schedule, ScheduleInput } from "@osiris/shared";
import { useEffect, useState, type FormEvent } from "react";
import { api } from "./api.ts";
import { attempt, ErrorNotice, Field } from "./Scope.tsx";
import { MasterDetail } from "./MasterDetail.tsx";

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
  // A task's id, or null for a new one.
  const [selected, setSelected] = useState<string | null>();
  const [error, setError] = useState<string>();
  const load = () => api.schedules(all).then(setList, (e: Error) => setError(e.message));
  useEffect(() => void load(), [all]);
  const open = list?.find((s) => s.id === selected);

  return (
    <MasterDetail
      title="Plánované úlohy"
      top={
        isAdmin && (
          <label className="flex items-center gap-2 px-2 py-1 text-xs">
            <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> všech uživatelů
          </label>
        )
      }
      groups={[
        {
          items: (list ?? []).map((s) => ({
            key: s.id,
            label: s.title,
            hint: `${describe(s)}${all && s.ownerName ? ` · ${s.ownerName}` : ""}`,
            muted: !s.enabled,
            badge: s.lastStatus === "failed" ? <span className="text-xs text-error">selhalo</span> : undefined,
          })),
          empty: "Zatím žádné úlohy.",
        },
      ]}
      selected={selected}
      onSelect={setSelected}
      add={{ label: "Nová úloha", onClick: () => setSelected(null) }}
      placeholder="Asistent úlohu spustí sám v nastavený čas, s tvými oprávněními. Výsledek najdeš jako novou konverzaci, případně i ve WhatsAppu. Úlohu můžeš zadat i v chatu, např. „každé ráno v 7 mi shrň dnešní zakázky“."
    >
      {error ? (
        <div className="detail">
          <ErrorNotice error={error} />
        </div>
      ) : selected === null || open ? (
        <ScheduleDetail
          key={open?.id ?? "new"}
          schedule={open}
          onOpenThread={onOpenThread}
          onSaved={(id) => void load().then(() => setSelected(id))}
          onDeleted={() => void load().then(() => setSelected(undefined))}
        />
      ) : undefined}
    </MasterDetail>
  );
}

function ScheduleDetail({
  schedule,
  onOpenThread,
  onSaved,
  onDeleted,
}: {
  schedule?: Schedule;
  onOpenThread: (id: string) => void;
  onSaved: (id: string) => void;
  onDeleted: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(schedule ? toDraft(schedule) : empty);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

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
      const saved = schedule ? await api.updateSchedule(schedule.id, input) : await api.createSchedule(input);
      setNotice("Uloženo.");
      onSaved(saved.id);
    });
  };
  const s = schedule;

  return (
    <div className="detail max-w-3xl space-y-4">
      <h1 className="text-lg font-semibold">{s ? s.title : "Nová úloha"}</h1>
      {s && (
        <div className="text-sm">
          <p className="text-fg-secondary">
            {describe(s)}
            {s.delivery === "whatsapp" && " · i na WhatsApp"}
            {s.ownerName && ` · ${s.ownerName}`}
          </p>
          <p className="mt-0.5 text-xs text-fg-muted">
            další spuštění {s.enabled ? when(s.nextRunAt) : "—"}
            {s.lastRunAt && ` · naposledy ${when(s.lastRunAt)} (${s.lastStatus ? STATUS[s.lastStatus] : "?"})`}
          </p>
          {s.lastError && <p className="mt-0.5 text-xs text-error">{s.lastError}</p>}
          <div className="mt-2 flex flex-wrap gap-2">
            {s.lastThreadId && (
              <button onClick={() => onOpenThread(s.lastThreadId!)} className="btn-secondary text-sm">
                Poslední výsledek
              </button>
            )}
            <button
              onClick={() => void attempt(setBusy, setError, async () => (await api.runSchedule(s.id), setNotice("Spuštěno, výsledek bude v nové konverzaci.")))}
              disabled={busy}
              className="btn-secondary text-sm"
            >
              Spustit teď
            </button>
            <span className="flex-1" />
            <button
              onClick={() => window.confirm(`Smazat úlohu „${s.title}“?`) && void attempt(setBusy, setError, async () => (await api.deleteSchedule(s.id), onDeleted()))}
              className="btn-danger text-sm"
            >
              Smazat
            </button>
          </div>
        </div>
      )}
      <form onSubmit={submit} className="space-y-3">
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
          <ErrorNotice error={error} />
          <div className="flex items-center gap-3">
            <button disabled={busy} className="btn-primary">
              {busy ? "Ukládám…" : "Uložit"}
            </button>
            {notice && <span className="text-sm text-success">{notice}</span>}
          </div>
      </form>
    </div>
  );
}
