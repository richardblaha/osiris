import { t } from "i18next";
import { useEffect, useState } from "react";
import { api, type ConnectionRecord, type ConnectorType, type DataOverview } from "./api.ts";
import { Icon } from "./Icon.tsx";
import { formatDateTime } from "./i18n.ts";
import { ErrorNotice } from "./ui.tsx";

const ID = /^[a-z][a-z0-9-]{0,39}$/;
const typeName = (id: string) => t(`instances:data.type.${id}` as "instances:data.type.mqtt", { defaultValue: id });
const fieldName = (name: string) => t(`instances:data.field.${name}` as "instances:data.field.url", { defaultValue: name });

interface Draft {
  id: string;
  name: string;
  type: string;
  settings: Record<string, string>;
  /** A string sets a secret, null removes it. */
  secrets: Record<string, string | null>;
}

/**
 * A twin's data (admins, the twin shown): the data profile it runs (from its models' `dataProfiles`, with what its
 * data hub does), and its connections to data sources — ClickHouse, Prometheus, MQTT, Kafka, RabbitMQ, a generator
 * for simulations, a simulated Kubernetes cluster — that the profiles' bindings name. Settings are shown, secrets only
 * as set or not; a new value replaces one.
 */
export function DataSources({ instance }: { instance: string }) {
  const [types, setTypes] = useState<ConnectorType[]>([]);
  const [list, setList] = useState<ConnectionRecord[]>();
  const [overview, setOverview] = useState<DataOverview>();
  const [draft, setDraft] = useState<Draft>();
  const [editing, setEditing] = useState<ConnectionRecord>();
  const [checks, setChecks] = useState<Record<string, string>>({});
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const [kinds, connections, data] = await Promise.all([api.connectorTypes(), api.connections(instance), api.dataProfiles()]);
    setTypes(kinds);
    setList(connections);
    setOverview(data);
  };
  useEffect(() => {
    void load().catch((e: Error) => setError(e.message));
  }, [instance]);

  const act = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const fresh = (type?: ConnectorType): Draft => ({ id: "", name: "", type: type?.id ?? "", settings: Object.fromEntries((type?.fields ?? []).filter((f) => !f.secret && f.default).map((f) => [f.name, f.default!])), secrets: {} });
  const edit = (c?: ConnectionRecord) => {
    setEditing(c);
    setDraft(c ? { id: c.id, name: c.name, type: c.type, settings: { ...c.settings }, secrets: {} } : fresh(types[0]));
  };
  const type = types.find((x) => x.id === draft?.type);
  const status = overview?.status;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4">
      <ErrorNotice error={error} />
      <section className="max-w-3xl">
        <p className="section-header">{t("instances:data.profile")}</p>
        <p className="mt-1 text-xs text-fg-muted">{t("instances:data.profileHelp")}</p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <select
            className="field py-1"
            value={overview?.active ?? "live"}
            disabled={busy}
            onChange={(e) => void act(() => api.setDataProfile(e.target.value))}
            aria-label={t("instances:data.profile")}
          >
            {[...new Set(["live", ...(overview?.profiles.map((p) => p.name) ?? [])])].map((name) => {
              const p = overview?.profiles.find((x) => x.name === name);
              return (
                <option key={name} value={name}>
                  {name}
                  {p ? ` (${t(`instances:data.kind.${p.kind}` as "instances:data.kind.live", { defaultValue: p.kind })}, ${t("instances:data.models", { count: p.models.length })})` : ""}
                </option>
              );
            })}
          </select>
          {status && <span className="text-xs text-fg-secondary">{t("instances:data.bound", { count: status.tasks })}</span>}
        </div>
      </section>

      <section className="mt-6 max-w-3xl">
        <div className="flex items-center gap-2">
          <p className="section-header flex-1">{t("instances:data.connections")}</p>
          <button type="button" className="btn-secondary px-2 py-1 text-xs" onClick={() => edit()}>
            <Icon name="add" className="me-1 h-4 w-4 align-[-0.2em]" />
            {t("instances:data.add")}
          </button>
        </div>
        <p className="mt-1 text-xs text-fg-muted">{t("instances:data.connectionsHelp")}</p>
        {list && !list.length && <p className="mt-2 text-sm text-fg-muted">{t("instances:data.none")}</p>}
        <ul className="mt-2 divide-y divide-line rounded border border-line">
          {list?.map((c) => {
            const s = status?.connections[c.id];
            return (
              <li key={c.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{c.name}</span>
                  <span className="block truncate text-xs text-fg-muted">
                    {c.id} · {typeName(c.type)}
                    {s ? ` · ${t("instances:data.bound", { count: s.tasks })}` : ""}
                    {s?.lastValueAt ? ` · ${t("instances:data.lastValue", { at: formatDateTime(s.lastValueAt) })}` : ""}
                  </span>
                  {s?.error && <span className="block truncate text-xs text-error" title={s.error}>{s.error}</span>}
                  {checks[c.id] && <span className={`block text-xs ${checks[c.id] === "ok" ? "text-success" : "text-error"}`}>{checks[c.id] === "ok" ? t("instances:data.checkOk") : checks[c.id]}</span>}
                </span>
                <button
                  type="button"
                  className="btn-secondary px-2 py-1 text-xs"
                  disabled={busy}
                  onClick={() => void act(async () => {
                    const r = await api.checkConnection(instance, c.id);
                    setChecks((x) => ({ ...x, [c.id]: r.ok ? "ok" : (r.error ?? "?") }));
                  })}
                >
                  {t("instances:data.check")}
                </button>
                <button type="button" className="btn-secondary px-2 py-1 text-xs" onClick={() => edit(c)}>
                  {t("instances:data.edit")}
                </button>
                <button
                  type="button"
                  className="btn-secondary px-2 py-1 text-xs text-error"
                  disabled={busy}
                  onClick={() => confirm(t("instances:data.confirmDelete", { name: c.name })) && void act(() => api.deleteConnection(instance, c.id))}
                >
                  {t("instances:delete")}
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      {draft && (
        <form
          className="mt-6 grid max-w-2xl gap-3 rounded border border-line p-3"
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              await api.saveConnection(instance, draft.id, { name: draft.name, type: draft.type, settings: draft.settings, secrets: Object.fromEntries(Object.entries(draft.secrets).filter(([, v]) => v !== "")) });
              setDraft(undefined);
              setEditing(undefined);
            });
          }}
        >
          <h3 className="font-semibold">{editing ? editing.name : t("instances:data.add")}</h3>
          <label className="grid gap-1 text-sm">
            <span className="font-medium">{t("instances:id")}</span>
            <input className="field" value={draft.id} disabled={!!editing} required pattern={ID.source.slice(1, -1)} maxLength={40} onChange={(e) => setDraft({ ...draft, id: e.target.value.toLowerCase() })} />
            <span className="text-xs text-fg-muted">{t("instances:data.idHelp")}</span>
          </label>
          <label className="grid gap-1 text-sm">
            <span className="font-medium">{t("instances:name")}</span>
            <input className="field" value={draft.name} required maxLength={80} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </label>
          <label className="grid gap-1 text-sm">
            <span className="font-medium">{t("instances:data.kindOf")}</span>
            <select className="field" value={draft.type} disabled={!!editing} onChange={(e) => setDraft({ ...fresh(types.find((x) => x.id === e.target.value)), id: draft.id, name: draft.name })}>
              {types.map((x) => (
                <option key={x.id} value={x.id}>
                  {typeName(x.id)}
                </option>
              ))}
            </select>
            {type && <span className="text-xs text-fg-muted">{t(`instances:data.typeHelp.${type.id}` as "instances:data.typeHelp.mqtt", { defaultValue: "" })}</span>}
          </label>
          {type?.fields.map((f) =>
            f.secret ? (
              <label key={f.name} className="grid gap-1 text-sm">
                <span className="font-medium">
                  {fieldName(f.name)} · {draft.secrets[f.name] === null ? t("instances:secret.removing") : editing?.secretNames.includes(f.name) ? t("instances:secret.set") : t("instances:secret.notSet")}
                </span>
                <input
                  className="field"
                  type="password"
                  autoComplete="new-password"
                  value={draft.secrets[f.name] ?? ""}
                  disabled={draft.secrets[f.name] === null}
                  placeholder={editing?.secretNames.includes(f.name) ? t("instances:secret.keep") : ""}
                  required={f.required && !editing?.secretNames.includes(f.name)}
                  onChange={(e) => setDraft({ ...draft, secrets: { ...draft.secrets, [f.name]: e.target.value } })}
                />
                {editing?.secretNames.includes(f.name) && (
                  <button type="button" className="justify-self-start text-xs text-primary" onClick={() => setDraft({ ...draft, secrets: { ...draft.secrets, [f.name]: draft.secrets[f.name] === null ? "" : null } })}>
                    {draft.secrets[f.name] === null ? t("instances:secret.undo") : t("instances:secret.remove")}
                  </button>
                )}
              </label>
            ) : (
              <label key={f.name} className="grid gap-1 text-sm">
                <span className="font-medium">{fieldName(f.name)}</span>
                {f.kind === "select" ? (
                  <select className="field" value={draft.settings[f.name] ?? f.default ?? ""} onChange={(e) => setDraft({ ...draft, settings: { ...draft.settings, [f.name]: e.target.value } })}>
                    {f.options?.map((o) => (
                      <option key={o}>{o}</option>
                    ))}
                  </select>
                ) : f.kind === "textarea" ? (
                  <textarea className="field font-mono text-xs" rows={4} value={draft.settings[f.name] ?? ""} onChange={(e) => setDraft({ ...draft, settings: { ...draft.settings, [f.name]: e.target.value } })} />
                ) : (
                  <input className="field" value={draft.settings[f.name] ?? ""} required={f.required} onChange={(e) => setDraft({ ...draft, settings: { ...draft.settings, [f.name]: e.target.value } })} />
                )}
              </label>
            ),
          )}
          <div className="flex gap-2">
            <button type="submit" className="btn-primary" disabled={busy}>
              {t("instances:save")}
            </button>
            <button type="button" className="btn-secondary" onClick={() => (setDraft(undefined), setEditing(undefined))}>
              {t("instances:data.cancel")}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
