import { FEATURES, type DirectoryUser, type Feature, type Role, type TenantDetail, type TenantSummary } from "@osiris/shared";
import { useEffect, useState, type FormEvent } from "react";
import { api } from "./api.ts";

const SLUG = /^(?!.*-admin$)[a-z0-9]+(-[a-z0-9]+)*$/;

export const FEATURE_LABELS: Record<Feature, { label: string; hint: string }> = {
  knowledge: { label: "Znalostní báze", hint: "dokumenty, ve kterých asistent vyhledává" },
  skills: { label: "Dovednosti", hint: "postupy, podle kterých asistent pracuje" },
  memory: { label: "Paměť", hint: "fakta, která si asistent pamatuje mezi konverzacemi" },
  mcp: { label: "Nástroje (MCP)", hint: "externí služby připojené přes MCP servery" },
  http: { label: "Webová API", hint: "nástroj http_request pro volání API z dovedností" },
  whatsapp: { label: "WhatsApp", hint: "asistent odpovídá i ve WhatsAppu" },
};

/** System admins (group osiris-admin): tenants, what they may use and who is in them. */
export function Tenants({ onChanged }: { onChanged: () => void }) {
  const [tenants, setTenants] = useState<TenantSummary[]>([]);
  const [selected, setSelected] = useState<string>();
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const refresh = () => api.admin.tenants().then(setTenants, (e: Error) => setError(e.message));
  useEffect(() => void refresh(), []);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await api.admin.createTenant(id, name);
      setId("");
      setName("");
      setSelected(id);
      await refresh();
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto h-full max-w-5xl overflow-y-auto p-6">
      <h1 className="section-header text-[13px]">Tenanti</h1>
      <p className="mt-1 text-sm text-fg-secondary">
        Každý tenant má vlastní databázi. Členství jsou skupiny v PocketID: <code>osiris-tenant-&lt;zkratka&gt;</code> pro
        členy a <code>osiris-tenant-&lt;zkratka&gt;-admin</code> pro správce.
      </p>

      <form onSubmit={create} className="mt-6 flex flex-wrap gap-2">
        <input
          value={id}
          onChange={(e) => setId(e.target.value.toLowerCase())}
          placeholder="zkratka, např. novak-stavby"
          pattern={SLUG.source}
          title="Malá písmena, číslice a pomlčky; nesmí končit na -admin"
          maxLength={40}
          required
          className="field w-56"
        />
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Název, např. Novák stavby s.r.o." required className="field min-w-0 flex-1" />
        <button disabled={busy} className="btn-primary">
          {busy ? "Zakládám…" : "Založit tenanta"}
        </button>
      </form>
      {error && <p className="notice notice-error mt-3 px-3 py-2 text-sm">{error}</p>}

      <div className="mt-8 grid gap-6 md:grid-cols-[16rem_1fr]">
        <ul className="divide-y divide-line">
          {tenants.map((t) => (
            <li key={t.id}>
              <button onClick={() => setSelected(t.id)} data-active={selected === t.id} className="list-row block w-full px-2 py-2 text-left">
                <span className="block font-medium">{t.name}</span>
                <span className="text-xs text-fg-muted">
                  {t.id} · {t.members} {t.members === 1 ? "uživatel" : t.members >= 2 && t.members <= 4 ? "uživatelé" : "uživatelů"}
                </span>
              </button>
            </li>
          ))}
          {!tenants.length && <li className="py-2 text-fg-muted">Zatím žádní tenanti.</li>}
        </ul>
        {selected ? (
          <TenantPanel
            key={selected}
            id={selected}
            onChanged={() => void refresh().then(onChanged)}
            onDeleted={() => {
              setSelected(undefined);
              void refresh().then(onChanged);
            }}
          />
        ) : (
          <p className="text-sm text-fg-muted">Vyber tenanta vlevo.</p>
        )}
      </div>
    </div>
  );
}

function TenantPanel({ id, onChanged, onDeleted }: { id: string; onChanged: () => void; onDeleted: () => void }) {
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
    <div className="space-y-8">
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
                  <option value="member">člen</option>
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
            <option value="member">člen</option>
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
