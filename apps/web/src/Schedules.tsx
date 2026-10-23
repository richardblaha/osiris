import type { Schedule, ScheduleInput } from "@osiris/shared";
import { useEffect, useState, type FormEvent } from "react";
import { api } from "./api.ts";
import { attempt, ErrorNotice, Field } from "./Scope.tsx";
import { MasterDetail } from "./MasterDetail.tsx";
import { t } from "i18next";
import { formatDateTime } from "./i18n.ts";

/** A time of day in the reader's format (7:00, 7:00 AM). */
const clock = (hour: number) => formatDateTime(new Date(2000, 0, 1, hour), { timeStyle: "short" });
const PRESETS: { label: () => string; cron: string }[] = [
  { label: () => t("schedules:presets.weekdays", { time: clock(7) }), cron: "0 7 * * 1-5" },
  { label: () => t("schedules:presets.daily", { time: clock(7) }), cron: "0 7 * * *" },
  { label: () => t("schedules:presets.monday", { time: clock(8) }), cron: "0 8 * * 1" },
  { label: () => t("schedules:presets.friday", { time: clock(15) }), cron: "0 15 * * 5" },
  { label: () => t("schedules:presets.monthly", { time: clock(8) }), cron: "0 8 1 * *" },
];

const when = (iso: string | null) => (iso ? formatDateTime(iso) : "—");
const describe = (s: Schedule) => (s.cron ? (PRESETS.find((p) => p.cron === s.cron)?.label() ?? `cron ${s.cron}`) : t("schedules:once", { time: when(s.runAt) }));
const status = (value: NonNullable<Schedule["lastStatus"]>) => t(`schedules:status.${value}`);

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
      title={t("app:nav.schedules")}
      loading={!list && !error}
      top={
        isAdmin && (
          <label className="flex items-center gap-2 px-2 py-1 text-xs">
            <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> {t("schedules:allUsers")}
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
            badge: s.lastStatus === "failed" ? <span className="text-xs text-error">{status("failed")}</span> : undefined,
          })),
          empty: t("schedules:empty"),
        },
      ]}
      selected={selected}
      onSelect={setSelected}
      add={{ label: t("schedules:new"), onClick: () => setSelected(null) }}
      placeholder={t("schedules:placeholder")}
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
      setNotice(t("savedNotice"));
      onSaved(saved.id);
    });
  };
  const s = schedule;

  return (
    <div className="detail max-w-3xl space-y-4">
      <h1 className="text-lg font-semibold">{s ? s.title : t("schedules:new")}</h1>
      {s && (
        <div className="text-sm">
          <p className="text-fg-secondary">
            {describe(s)}
            {s.delivery === "whatsapp" && ` · ${t("schedules:alsoWhatsapp")}`}
            {s.ownerName && ` · ${s.ownerName}`}
          </p>
          <p className="mt-0.5 text-xs text-fg-muted">
            {t("schedules:next", { time: s.enabled ? when(s.nextRunAt) : "—" })}
            {s.lastRunAt && ` · ${t("schedules:last", { time: when(s.lastRunAt), status: s.lastStatus ? status(s.lastStatus) : "?" })}`}
          </p>
          {s.lastError && <p className="mt-0.5 text-xs text-error">{s.lastError}</p>}
          <div className="mt-2 flex flex-wrap gap-2">
            {s.lastThreadId && (
              <button onClick={() => onOpenThread(s.lastThreadId!)} className="btn-secondary text-sm">
                {t("schedules:lastResult")}
              </button>
            )}
            <button
              onClick={() => void attempt(setBusy, setError, async () => (await api.runSchedule(s.id), setNotice(t("schedules:started"))))}
              disabled={busy}
              className="btn-secondary text-sm"
            >
              {t("schedules:runNow")}
            </button>
            <span className="flex-1" />
            <button
              onClick={() => window.confirm(t("schedules:confirmDelete", { title: s.title })) && void attempt(setBusy, setError, async () => (await api.deleteSchedule(s.id), onDeleted()))}
              className="btn-danger text-sm"
            >
              {t("delete")}
            </button>
          </div>
        </div>
      )}
      <form onSubmit={submit} className="space-y-3">
          <Field label={t("name")}>
            <input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} required maxLength={100} className="field" />
          </Field>
          <Field label={t("schedules:prompt")}>
            <textarea value={draft.prompt} onChange={(e) => setDraft({ ...draft, prompt: e.target.value })} required maxLength={4000} rows={4} className="field" />
          </Field>
          <div className="flex flex-wrap gap-3">
            <Field label={t("schedules:when")}>
              <select value={draft.mode} onChange={(e) => setDraft({ ...draft, mode: e.target.value as Draft["mode"] })} className="field w-auto">
                <option value="cron">{t("schedules:repeat")}</option>
                <option value="once">{t("schedules:onceOption")}</option>
              </select>
            </Field>
            {draft.mode === "cron" ? (
              <>
                <Field label={t("schedules:recurrence")}>
                  <select
                    value={PRESETS.some((p) => p.cron === draft.cron) ? draft.cron : "custom"}
                    onChange={(e) => setDraft({ ...draft, cron: e.target.value === "custom" ? "" : e.target.value })}
                    className="field w-auto"
                  >
                    {PRESETS.map((p) => (
                      <option key={p.cron} value={p.cron}>
                        {p.label()}
                      </option>
                    ))}
                    <option value="custom">{t("schedules:custom")}</option>
                  </select>
                </Field>
                {!PRESETS.some((p) => p.cron === draft.cron) && (
                  <Field label={t("schedules:cron")}>
                    <input value={draft.cron} onChange={(e) => setDraft({ ...draft, cron: e.target.value })} placeholder="30 6 * * 1-5" required className="field w-auto" />
                  </Field>
                )}
              </>
            ) : (
              <Field label={t("schedules:dateTime")}>
                <input type="datetime-local" value={draft.runAt} onChange={(e) => setDraft({ ...draft, runAt: e.target.value })} required className="field w-auto" />
              </Field>
            )}
            <Field label={t("schedules:delivery")}>
              <select value={draft.delivery} onChange={(e) => setDraft({ ...draft, delivery: e.target.value as Draft["delivery"] })} className="field w-auto">
                <option value="web">{t("schedules:chatOnly")}</option>
                <option value="whatsapp">{t("schedules:alsoWhatsapp")}</option>
              </select>
            </Field>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} /> {t("schedules:enabled")}
          </label>
          <ErrorNotice error={error} />
          <div className="flex items-center gap-3">
            <button disabled={busy} className="btn-primary">
              {busy ? t("saving") : t("save")}
            </button>
            {notice && <span className="text-sm text-success">{notice}</span>}
          </div>
      </form>
    </div>
  );
}
