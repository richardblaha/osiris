import { FEATURES, type DirectoryUser, type Feature, type Role, type TenantDetail, type TenantSummary } from "@osiris/shared";
import { useEffect, useState, type FormEvent } from "react";
import { api } from "./api.ts";
import { attempt, ErrorNotice, Field } from "./Scope.tsx";

const SLUG = /^(?!.*-(admin|user)$)[a-z0-9]+(-[a-z0-9]+)*$/;

export const FEATURE_LABELS: Record<Feature, { label: string; hint: string }> = {
  knowledge: { label: "Znalostní báze", hint: "dokumenty, ve kterých asistent vyhledává" },
  skills: { label: "Dovednosti", hint: "postupy, podle kterých asistent pracuje" },
  memory: { label: "Paměť", hint: "fakta, která si asistent pamatuje mezi konverzacemi" },
  mcp: { label: "Nástroje (MCP)", hint: "externí služby připojené přes MCP servery" },
  http: { label: "Webová API", hint: "nástroj http_request pro volání API z dovedností" },
  whatsapp: { label: "WhatsApp", hint: "asistent odpovídá i ve WhatsAppu" },
};

/** System admins (group osiris-admin) create tenants here; each tenant's detail is a `TenantPanel`. */
export function NewTenant({ onCreated }: { onCreated: (id: string) => void }) {
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const create = (e: FormEvent) => {
    e.preventDefault();
    void attempt(setBusy, setError, async () => {
      await api.admin.createTenant(id, name);
      onCreated(id);
    });
  };

  return (
    <div className="detail">
      <h1 className="text-lg font-semibold">Nový tenant</h1>
      <p className="mt-1 text-sm text-fg-secondary">
        Každý tenant má vlastní databázi. Členství jsou skupiny v PocketID: <code>osiris-tenant-&lt;zkratka&gt;-user</code> pro
        uživatele a <code>osiris-tenant-&lt;zkratka&gt;-admin</code> pro správce.
      </p>
      <form onSubmit={create} className="mt-6 space-y-4">
        <Field label="Zkratka">
          <input
            value={id}
            onChange={(e) => setId(e.target.value.toLowerCase())}
            placeholder="např. novak-stavby"
            pattern={SLUG.source}
            title="Malá písmena, číslice a pomlčky; nesmí končit na -admin ani -user"
            maxLength={40}
            required
            className="field"
          />
        </Field>
        <Field label="Název">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="např. Novák stavby s.r.o." required className="field" />
        </Field>
        <button disabled={busy} className="btn-primary">
          {busy ? "Zakládám…" : "Založit tenanta"}
        </button>
      </form>
      <ErrorNotice error={error} />
    </div>
  );
}

export function TenantPanel({ id, onChanged, onDeleted }: { id: string; onChanged: () => void; onDeleted: () => void }) {
  const [tenant, setTenant] = useState<TenantDetail>();
  const [users, setUsers] = useState<DirectoryUser[]>([]);
  const [name, setName] = useState("");
  const [newUser, setNewUser] = useState("");
  const [newRole, setNewRole] = useState<Role>("member");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const load = () =>
    api.admin.tenant(id).then((t) => {
      setTenant(t);
      setName(t.name);
    });

  useEffect(() => {
    load().catch((e: Error) => setError(e.message));
    api.admin.users().then(setUsers, (e: Error) => setError(e.message));
  }, []);

  /** Runs a change, reloads the tenant and tells the parent (names, members and features show elsewhere too). */
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
      await load();
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!tenant) return error ? <p className="notice notice-error px-3 py-2 text-sm">{error}</p> : null;
  const memberIds = new Set(tenant.memberList.map((m) => m.userId));
  const candidates = users.filter((u) => !memberIds.has(u.id));

  return (
    <div className="detail space-y-8">
      <h1 className="text-lg font-semibold">{tenant.name}</h1>
      <section>
        <h2 className="section-header">Název</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => api.admin.updateTenant(id, { name }));
          }}
          className="mt-2 flex gap-2"
        >
          <input value={name} onChange={(e) => setName(e.target.value)} required className="field min-w-0 flex-1" />
          <button disabled={busy || name === tenant.name} className="btn-secondary">
            Přejmenovat
          </button>
        </form>
        <p className="mt-1 text-xs text-fg-muted">Zkratka: {tenant.id}</p>
      </section>

      <section>
        <h2 className="section-header">Povolené funkce</h2>
        <div className="mt-2 space-y-1.5">
          {FEATURES.map((f) => (
            <label key={f} className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={tenant.features[f]}
                disabled={busy}
                onChange={(e) => void run(() => api.admin.updateTenant(id, { features: { [f]: e.target.checked } }))}
                className="mt-0.5"
              />
              <span>
                {FEATURE_LABELS[f].label} <span className="text-fg-muted">· {FEATURE_LABELS[f].hint}</span>
              </span>
            </label>
          ))}
        </div>
      </section>

      <section>
        <h2 className="section-header">Uživatelé</h2>
        <ul className="mt-2 divide-y divide-line">
          {tenant.memberList.map((m) => (
            <li key={m.userId} className="flex items-center justify-between gap-3 py-2 text-sm">
              <span className="min-w-0 truncate">
                {m.name ?? m.email ?? m.userId}
                {m.name && m.email && <span className="text-fg-muted"> · {m.email}</span>}
              </span>
              <span className="flex shrink-0 items-center gap-3">
                <select
                  value={m.role}
                  disabled={busy}
                  onChange={(e) => void run(() => api.admin.setMember(id, m.userId, e.target.value as Role))}
                  className="field w-auto py-1"
                >
                  <option value="member">uživatel</option>
                  <option value="admin">správce</option>
                </select>
                <button disabled={busy} onClick={() => void run(() => api.admin.removeMember(id, m.userId))} className="btn-danger">
                  Odebrat
                </button>
              </span>
            </li>
          ))}
          {!tenant.memberList.length && <li className="py-2 text-sm text-fg-muted">Zatím nikdo.</li>}
        </ul>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await api.admin.setMember(id, newUser, newRole);
              setNewUser("");
            });
          }}
          className="mt-3 flex flex-wrap gap-2"
        >
          <select value={newUser} onChange={(e) => setNewUser(e.target.value)} required className="field min-w-0 flex-1">
            <option value="">Přidat uživatele…</option>
            {candidates.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name ?? u.email ?? u.id}
                {u.name && u.email ? ` (${u.email})` : ""}
              </option>
            ))}
          </select>
          <select value={newRole} onChange={(e) => setNewRole(e.target.value as Role)} className="field w-auto">
            <option value="member">uživatel</option>
            <option value="admin">správce</option>
          </select>
          <button disabled={busy || !newUser} className="btn-primary">
            Přidat
          </button>
        </form>
        <p className="mt-1 text-xs text-fg-muted">Uživatelé se zakládají v PocketID. Změny členství platí do minuty.</p>
      </section>

      {error && <p className="notice notice-error px-3 py-2 text-sm">{error}</p>}

      <section className="border-t border-line pt-6">
        <h2 className="section-header text-error">Odebrat tenanta</h2>
        <p className="mt-1 text-sm text-fg-secondary">
          Smaže skupiny v PocketID, takže nikdo z tenanta se už nepřihlásí. Databáze se archivuje a data zůstanou zachovaná.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setBusy(true);
            setError(undefined);
            api.admin.deleteTenant(id).then(onDeleted, (err: Error) => {
              setError(err.message);
              setBusy(false);
            });
          }}
          className="mt-2 flex gap-2"
        >
          <input value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder={`Pro potvrzení napiš ${tenant.id}`} className="field min-w-0 flex-1" />
          <button disabled={busy || confirm !== tenant.id} className="btn-danger">
            Odebrat
          </button>
        </form>
      </section>
    </div>
  );
}
