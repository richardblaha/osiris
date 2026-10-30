import { t } from "i18next";
import { useEffect, useState } from "react";
import { api, type InstanceRecord, type SourceField, type SourceType } from "./api.ts";
import { ErrorNotice, Pending } from "./ui.tsx";

/** A form's state: the instance's id, name, type, settings, and the secrets typed in (null: remove it). */
interface Draft {
  id: string;
  name: string;
  sourceType: string;
  settings: Record<string, string>;
  secrets: Record<string, string | null>;
}

const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const label = (type: string, field: string) => t(`instances:field.${type}.${field}` as "instances:field.kubernetes.connection", { defaultValue: field });
const help = (type: string, field: string) => t(`instances:help.${type}.${field}` as "instances:help.kubernetes.connection", { defaultValue: "" });
const typeName = (type: string) => t(`instances:type.${type}` as "instances:type.kubernetes", { defaultValue: type });
const optionName = (type: string, field: string, option: string) =>
  t(`instances:option.${type}.${field}.${option}` as "instances:option.kubernetes.connection.inCluster", { defaultValue: option });

const draftOf = (r: InstanceRecord): Draft => ({ id: r.id, name: r.name, sourceType: r.sourceType, settings: { ...r.settings }, secrets: {} });
const newDraft = (type?: SourceType): Draft => ({
  id: "",
  name: "",
  sourceType: type?.id ?? "",
  settings: Object.fromEntries((type?.fields ?? []).filter((f) => !f.secret && f.default).map((f) => [f.name, f.default!])),
  secrets: {},
});

/**
 * The digital twins, for admins: each twin is an instance of a kind of source (Kubernetes…) with its settings; secrets
 * (a kubeconfig, a password) are write-only: the form shows whether one is set, a new value replaces it. Who sees a
 * twin is osiris-auth's group `twin:<id>` (admins see all of them).
 */
export function Instances({ onChanged }: { onChanged: (id?: string) => void }) {
  const [records, setRecords] = useState<InstanceRecord[]>();
  const [types, setTypes] = useState<SourceType[]>([]);
  const [draft, setDraft] = useState<Draft>();
  const [editing, setEditing] = useState<InstanceRecord>();
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  const load = async () => {
    const [list, kinds] = await Promise.all([api.adminInstances(), api.sourceTypes()]);
    setRecords(list);
    setTypes(kinds);
    return { list, kinds };
  };
  useEffect(() => {
    void load().then(
      ({ list, kinds }) => (list[0] ? (setEditing(list[0]), setDraft(draftOf(list[0]))) : setDraft(newDraft(kinds[0]))),
      (e: Error) => setError(e.message),
    );
  }, []);

  if (!records || !draft) return <Pending error={error} className="relative h-full" />;
  const type = types.find((x) => x.id === draft.sourceType);
  const isNew = !editing;
  const visible = (f: SourceField) => !f.when || (draft.settings[f.when.field] ?? types.find((x) => x.id === draft.sourceType)?.fields.find((g) => g.name === f.when!.field)?.default) === f.when.value;
  const set = (name: string, value: string) => setDraft({ ...draft, settings: { ...draft.settings, [name]: value } });
  const setSecret = (name: string, value: string | null) => setDraft({ ...draft, secrets: { ...draft.secrets, [name]: value } });

  const pick = (r?: InstanceRecord) => {
    setError(undefined);
    setEditing(r);
    setDraft(r ? draftOf(r) : newDraft(types[0]));
  };
  const save = async () => {
    setSaving(true);
    setError(undefined);
    try {
      const saved = await api.saveInstance(draft.id, { name: draft.name, sourceType: draft.sourceType, settings: draft.settings, secrets: draft.secrets });
      const { list } = await load();
      const now = list.find((r) => r.id === saved.id) ?? saved;
      setEditing(now);
      setDraft(draftOf(now));
      onChanged(saved.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const remove = async () => {
    if (!editing || !confirm(t("instances:confirmDelete", { name: editing.name }))) return;
    try {
      await api.deleteInstance(editing.id);
      const { list } = await load();
      pick(list[0]);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="flex h-full min-h-0">
      <nav className="w-60 shrink-0 overflow-y-auto border-e border-line p-2" aria-label={t("instances:title")}>
        <p className="section-header px-2 py-1">{t("instances:title")}</p>
        {records.map((r) => (
          <button key={r.id} type="button" onClick={() => pick(r)} data-active={editing?.id === r.id} className="list-row block w-full rounded px-2 py-1.5 text-start text-sm">
            <span className="block truncate">{r.name}</span>
            <span className="block truncate text-xs text-fg-muted">
              {typeName(r.sourceType)} · {r.error ? <span className="text-error">{t("instances:failing")}</span> : r.id}
            </span>
          </button>
        ))}
        <button type="button" onClick={() => pick()} data-active={isNew} className="list-row mt-1 block w-full rounded border-t border-line px-2 py-1.5 text-start text-sm text-primary">
          + {t("instances:new")}
        </button>
      </nav>

      <form
        className="min-w-0 flex-1 overflow-y-auto p-4"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <h2 className="font-semibold">{isNew ? t("instances:new") : editing.name}</h2>
        {editing?.error && <p className="notice notice-error mt-3 px-3 py-2 text-sm">{t("instances:error", { error: editing.error })}</p>}
        <ErrorNotice error={error} />

        <div className="mt-4 grid max-w-2xl gap-3">
          <Field label={t("instances:id")} help={isNew ? t("instances:idHelp") : t("instances:access", { group: `twin:${draft.id}` })}>
            <input
              className="field"
              value={draft.id}
              disabled={!isNew}
              required
              pattern={ID.source.slice(1, -1)}
              maxLength={40}
              onChange={(e) => setDraft({ ...draft, id: e.target.value.toLowerCase() })}
            />
          </Field>
          <Field label={t("instances:name")}>
            <input className="field" value={draft.name} required maxLength={80} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </Field>
          <Field label={t("instances:sourceType")}>
            <select
              className="field"
              value={draft.sourceType}
              onChange={(e) => setDraft({ ...newDraft(types.find((x) => x.id === e.target.value)), id: draft.id, name: draft.name })}
            >
              {types.map((x) => (
                <option key={x.id} value={x.id}>
                  {typeName(x.id)}
                </option>
              ))}
            </select>
          </Field>

          {type?.fields.filter(visible).map((f) =>
            f.secret ? (
              <SecretInput
                key={f.name}
                field={f}
                type={type.id}
                isSet={!!editing?.secretNames.includes(f.name)}
                value={draft.secrets[f.name]}
                onChange={(v) => setSecret(f.name, v)}
              />
            ) : (
              <Field key={f.name} label={label(type.id, f.name)} help={help(type.id, f.name)}>
                {f.kind === "select" ? (
                  <select className="field" value={draft.settings[f.name] ?? f.default ?? ""} onChange={(e) => set(f.name, e.target.value)}>
                    {f.options?.map((o) => (
                      <option key={o} value={o}>
                        {optionName(type.id, f.name, o)}
                      </option>
                    ))}
                  </select>
                ) : f.kind === "textarea" ? (
                  <textarea className="field font-mono text-xs" rows={6} value={draft.settings[f.name] ?? ""} onChange={(e) => set(f.name, e.target.value)} />
                ) : (
                  <input
                    className="field"
                    type={f.kind === "url" ? "url" : "text"}
                    value={draft.settings[f.name] ?? ""}
                    required={f.required}
                    onChange={(e) => set(f.name, e.target.value)}
                  />
                )}
              </Field>
            ),
          )}
        </div>

        <div className="mt-5 flex gap-2">
          <button type="submit" className="btn-primary" disabled={saving}>
            {saving ? t("instances:saving") : isNew ? t("instances:create") : t("instances:save")}
          </button>
          {!isNew && (
            <button type="button" className="btn-secondary text-error" onClick={() => void remove()}>
              {t("instances:delete")}
            </button>
          )}
        </div>
      </form>
    </div>
  );
}

function Field({ label, help, children }: { label: string; help?: string; children: React.ReactNode }) {
  return (
    <label className="grid gap-1 text-sm">
      <span className="font-medium">{label}</span>
      {children}
      {help && <span className="text-xs text-fg-muted">{help}</span>}
    </label>
  );
}

/** A write-only secret: whether one is set, a new value to replace it, or removing it. */
function SecretInput({ field, type, isSet, value, onChange }: { field: SourceField; type: string; isSet: boolean; value: string | null | undefined; onChange: (v: string | null) => void }) {
  const removing = value === null;
  const status = removing ? t("instances:secret.removing") : isSet ? t("instances:secret.set") : t("instances:secret.notSet");
  return (
    <Field label={`${label(type, field.name)} · ${status}`} help={help(type, field.name)}>
      {field.kind === "textarea" ? (
        <textarea
          className="field font-mono text-xs"
          rows={6}
          value={value ?? ""}
          disabled={removing}
          placeholder={isSet ? t("instances:secret.keep") : ""}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <input className="field" type="password" value={value ?? ""} disabled={removing} placeholder={isSet ? t("instances:secret.keep") : ""} autoComplete="new-password" onChange={(e) => onChange(e.target.value)} />
      )}
      {isSet && (
        <button type="button" className="justify-self-start text-xs text-primary" onClick={() => onChange(removing ? "" : null)}>
          {removing ? t("instances:secret.undo") : t("instances:secret.remove")}
        </button>
      )}
    </Field>
  );
}
