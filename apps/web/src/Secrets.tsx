import type { Scope, SecretSummary } from "@osiris/shared";
import { useEffect, useState, type FormEvent } from "react";
import { api } from "./api.ts";
import { ScopeBadge, ScopeSelect } from "./Scope.tsx";

const NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const parseHosts = (text: string) => text.split(/[\s,]+/).map((h) => h.trim().toLowerCase()).filter(Boolean);

export function Secrets({ isAdmin }: { isAdmin: boolean }) {
  const [secrets, setSecrets] = useState<SecretSummary[]>([]);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [hosts, setHosts] = useState("");
  const [description, setDescription] = useState("");
  const [scope, setScope] = useState<Scope>("personal");
  const [editing, setEditing] = useState<SecretSummary>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const refresh = () => api.secrets().then(setSecrets, (e: Error) => setError(e.message));
  useEffect(() => void refresh(), []);

  const reset = () => {
    setName("");
    setValue("");
    setHosts("");
    setDescription("");
    setScope("personal");
    setEditing(undefined);
  };

  const edit = (s: SecretSummary) => {
    setEditing(s);
    setName(s.name);
    setValue("");
    setHosts(s.allowedHosts.join(", "));
    setDescription(s.description);
    setScope(s.scope);
  };

  const canManage = (s: SecretSummary) => s.scope === "personal" || isAdmin;

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      // When editing, an empty value keeps the stored one.
      await api.saveSecret(name, { value: value || undefined, allowedHosts: parseHosts(hosts), description, scope });
      reset();
      await refresh();
    });
  };

  return (
    <div className="mx-auto h-full max-w-3xl overflow-y-auto p-6">
      <h1 className="section-header text-[13px]">Klíče a hesla</h1>
      <p className="mt-1 text-sm text-fg-secondary">
        API klíče a tokeny pro MCP servery a webová API. Ukládají se šifrovaně a po uložení už je nikdo neuvidí, ani ty.
        Používají se jako <code className="text-fg">{"{{secret:NÁZEV}}"}</code> a odešlou se jen na povolené domény.
      </p>

      <form onSubmit={submit} className="mt-6 space-y-2" autoComplete="off">
        <div className="flex gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_"))}
            placeholder="NÁZEV, např. FAKTUROID_TOKEN"
            pattern={NAME.source}
            readOnly={!!editing}
            required
            className="field w-72 shrink-0"
          />
          <input
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={editing ? "Nová hodnota (prázdné = beze změny)" : "Hodnota"}
            required={!editing}
            autoComplete="new-password"
            className="field min-w-0 flex-1"
          />
        </div>
        <input
          value={hosts}
          onChange={(e) => setHosts(e.target.value)}
          placeholder="Povolené domény, např. api.fakturoid.cz, *.example.com"
          required
          className="field"
        />
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="K čemu slouží (vidí ho i asistent)"
          maxLength={300}
          className="field"
        />
        <div className="flex items-center gap-2">
          <button disabled={busy} className="btn-primary">
            {busy ? "Ukládám…" : editing ? "Uložit" : "Přidat"}
          </button>
          <ScopeSelect isAdmin={isAdmin} value={scope} onChange={setScope} disabled={!!editing} />
          {editing && (
            <button type="button" onClick={reset} className="btn-secondary">
              Zrušit
            </button>
          )}
        </div>
      </form>
      {error && <p className="notice notice-error mt-3 px-3 py-2 text-sm">{error}</p>}

      <ul className="mt-8 divide-y divide-line">
        {secrets.map((s) => (
          <li key={`${s.scope}:${s.name}`} className="flex items-center justify-between gap-4 py-3">
            <span className="min-w-0">
              <span className="font-medium">{s.name}</span>
              <span className="ml-2">
                <ScopeBadge scope={s.scope} />
              </span>
              <span className="block truncate text-sm text-fg-secondary">
                {s.allowedHosts.join(", ")}
                {s.description && ` · ${s.description}`}
              </span>
            </span>
            {canManage(s) && (
              <span className="flex shrink-0 gap-3 text-sm">
                <button onClick={() => edit(s)} className="btn-link">
                  Upravit
                </button>
                <button
                  onClick={() => run(async () => (await api.deleteSecret(s.name, s.scope), await refresh()))}
                  className="btn-danger"
                >
                  Smazat
                </button>
              </span>
            )}
          </li>
        ))}
        {!secrets.length && <li className="py-3 text-fg-muted">Zatím žádné klíče.</li>}
      </ul>
    </div>
  );
}
