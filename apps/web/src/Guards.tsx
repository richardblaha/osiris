import { GUARD_NAME, type Guard, type Guards as GuardList } from "@osiris/shared";
import { useEffect, useState, type FormEvent } from "react";
import { api } from "./api.ts";
import { MasterDetail, type PanelGroup } from "./MasterDetail.tsx";
import { attempt, ErrorNotice, Field } from "./Scope.tsx";
import { t } from "i18next";

type Level = "system" | "project" | "user" | "assistant";
interface Place {
  level: Level;
  assistant?: string;
}

const keyOf = (p: Place, name: string) => [p.level, p.assistant ?? "", name].join(":");
const levelLabel = (level: Level) => t(`guards:levels.${level}`);

/**
 * Guards by level: the system's (system admins), the project's and its public assistants' (project admins) and the
 * user's own. Each is a rule the assistant keeps to and every message and answer is checked against.
 */
export function Guards({ isAdmin, systemAdmin }: { isAdmin: boolean; systemAdmin: boolean }) {
  const [list, setList] = useState<GuardList>();
  const [selected, setSelected] = useState<string | null>();
  const [error, setError] = useState<string>();
  const load = () => api.guards().then(setList, (e: Error) => setError(e.message));
  useEffect(() => void load(), []);

  const places: { place: Place; title: string; guards: Guard[]; editable: boolean }[] = list
    ? [
        { place: { level: "system" }, title: t("guards:places.system"), guards: list.system, editable: systemAdmin },
        { place: { level: "project" }, title: levelLabel("project"), guards: list.project, editable: isAdmin },
        { place: { level: "user" }, title: levelLabel("user"), guards: list.user, editable: true },
        ...Object.entries(list.assistants ?? {}).map(([name, guards]) => ({
          place: { level: "assistant" as const, assistant: name },
          title: t("guards:places.assistant", { name }),
          guards,
          editable: isAdmin,
        })),
      ]
    : [];
  const groups: PanelGroup[] = places.map((p) => ({
    title: p.title,
    items: p.guards.map((g) => ({ key: keyOf(p.place, g.name), label: g.name, hint: g.description || g.rule })),
    empty: t("guards:none"),
  }));
  const open = places.flatMap((p) => p.guards.map((g) => ({ ...p, guard: g }))).find((x) => keyOf(x.place, x.guard.name) === selected);
  const targets = places.filter((p) => p.editable);

  return (
    <MasterDetail
      title={t("app:nav.guards")}
      loading={!list && !error}
      top={<p className="px-2 text-xs text-fg-muted">{t("guards:intro")}</p>}
      groups={groups}
      selected={selected}
      onSelect={setSelected}
      add={{ label: t("guards:add"), onClick: () => setSelected(null) }}
      placeholder={t("guards:select")}
    >
      {error ? (
        <div className="detail">
          <ErrorNotice error={error} />
        </div>
      ) : selected === null && list ? (
        <GuardForm key="new" targets={targets} systemAdmin={systemAdmin} onSaved={(p, name) => void load().then(() => setSelected(keyOf(p, name)))} />
      ) : open ? (
        <GuardForm
          key={selected}
          targets={[open]}
          guard={open.guard}
          editable={open.editable}
          systemAdmin={systemAdmin}
          onSaved={() => void load()}
          onDeleted={() => void load().then(() => setSelected(undefined))}
        />
      ) : undefined}
    </MasterDetail>
  );
}

const save = (p: Place, g: Guard) => (p.level === "system" ? api.admin.saveGuard(g) : api.saveGuard(p.level, g, p.assistant));
const remove = (p: Place, name: string) => (p.level === "system" ? api.admin.deleteGuard(name) : api.deleteGuard(p.level, name, p.assistant));

function GuardForm(props: {
  targets: { place: Place; title: string }[];
  guard?: Guard;
  editable?: boolean;
  systemAdmin: boolean;
  onSaved: (p: Place, name: string) => void;
  onDeleted?: () => void;
}) {
  const editable = props.editable ?? true;
  const [target, setTarget] = useState(0);
  const [name, setName] = useState(props.guard?.name ?? "");
  const [description, setDescription] = useState(props.guard?.description ?? "");
  const [rule, setRule] = useState(props.guard?.rule ?? "");
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const place = props.targets[target]?.place;
  if (!place) return <p className="detail text-sm text-fg-muted">{t("guards:nowhere")}</p>;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setSaved(false);
    void attempt(setBusy, setError, async () => {
      await save(place, { name, description, rule });
      setSaved(true);
      props.onSaved(place, name);
    });
  };
  const del = () =>
    window.confirm(t("guards:confirmDelete", { name })) && void attempt(setBusy, setError, async () => (await remove(place, name), props.onDeleted?.()));

  return (
    <form onSubmit={submit} className="detail space-y-4">
      <h1 className="text-lg font-semibold">{props.guard ? props.guard.name : t("guards:new")}</h1>
      {props.guard ? (
        <p className="text-sm text-fg-secondary">
          {levelLabel(place.level)}
          {place.assistant && ` ${place.assistant}`}
          {!editable && ` · ${place.level === "system" ? t("guards:systemAdminOnly") : t("guards:projectAdminOnly")}`}
        </p>
      ) : (
        <Field label={t("guards:target")}>
          <select value={target} onChange={(e) => setTarget(Number(e.target.value))} className="field w-auto">
            {props.targets.map((target, i) => (
              <option key={target.title} value={i}>
                {target.title}
              </option>
            ))}
          </select>
        </Field>
      )}
      {!props.guard && (
        <Field label={t("guards:name")}>
          <input
            value={name}
            onChange={(e) => setName(e.target.value.trim().toLowerCase())}
            required
            maxLength={60}
            pattern={GUARD_NAME.source}
            placeholder={t("guards:namePlaceholder")}
            className="field"
          />
        </Field>
      )}
      <Field label={t("guards:description")}>
        <input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} disabled={!editable} className="field" />
      </Field>
      <Field label={t("guards:rule")}>
        <textarea
          value={rule}
          onChange={(e) => setRule(e.target.value)}
          required
          maxLength={4000}
          rows={6}
          disabled={!editable}
          placeholder={t("guards:rulePlaceholder")}
          className="field"
        />
      </Field>
      <ErrorNotice error={error} />
      {editable && (
        <div className="flex items-center gap-3">
          <button disabled={busy} className="btn-primary">
            {t("save")}
          </button>
          {saved && <span className="text-sm text-success">{t("savedNotice")}{place.level === "system" && ` ${t("guards:systemDelay")}`}</span>}
          <span className="flex-1" />
          {props.guard && (
            <button type="button" disabled={busy} onClick={del} className="btn-danger text-sm">
              {t("delete")}
            </button>
          )}
        </div>
      )}
    </form>
  );
}
