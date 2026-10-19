import { FEATURES, type DirectoryUser, type Feature, type Role, type TenantDetail, type TenantSummary } from "@osiris/shared";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { api } from "./api.ts";
import { InviteForm } from "./Invite.tsx";
import { attempt, ErrorNotice, Field } from "./Scope.tsx";
import { LoginLink } from "./TenantInfo.tsx";
import { fileSize } from "./Files.tsx";

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export const FEATURE_LABELS: Record<Feature, { label: string; hint: string }> = {
  knowledge: { label: "Znalostní báze", hint: "dokumenty, ve kterých asistent vyhledává" },
  skills: { label: "Dovednosti", hint: "postupy, podle kterých asistent pracuje" },
  memory: { label: "Paměť", hint: "fakta, která si asistent pamatuje mezi konverzacemi" },
  mcp: { label: "Nástroje (MCP)", hint: "externí služby připojené přes MCP servery" },
  http: { label: "Webová API", hint: "nástroj http_request pro volání API z dovedností" },
  whatsapp: { label: "WhatsApp", hint: "asistent odpovídá i ve WhatsAppu" },
  files: { label: "Soubory", hint: "úložiště šablon, obrázků a dokumentů, se kterými asistent pracuje" },
  scheduler: { label: "Plánované úlohy", hint: "asistent v nastavený čas sám spustí zadaný úkol" },
  sites: { label: "Weby", hint: "publikování webu tenanta na vlastní doméně" },
};

/** System admins (claim role=osiris-admin) create tenants here; each tenant's detail is a `TenantPanel`. */
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
        Každý tenant běží ve vlastním kontejneru s vlastní databází a soubory. Členství jsou claimy uživatelů:{" "}
        <code>tenant=&lt;zkratka&gt;</code> pro uživatele a <code>tenant-admin=&lt;zkratka&gt;</code> pro správce, oba potřebují{" "}
        <code>role=osiris-user</code>.
      </p>
      <form onSubmit={create} className="mt-6 space-y-4">
        <Field label="Zkratka">
          <input
            value={id}
            onChange={(e) => setId(e.target.value.toLowerCase())}
            placeholder="např. novak-stavby"
            pattern={SLUG.source}
            title="Malá písmena, číslice a pomlčky"
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
  const [ops, setOps] = useState({ idleMinutes: 30, storageGb: 5 });
  const [link, setLink] = useState<{ who: string; url: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const load = () =>
    api.admin.tenant(id).then((t) => {
      setTenant(t);
      setName(t.name);
      setOps({ idleMinutes: t.idleMinutes, storageGb: t.storageGb });
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
        <h2 className="section-header">Provoz</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => api.admin.updateTenant(id, ops));
          }}
          className="mt-2 flex flex-wrap items-end gap-3"
        >
          <Field label="Uspat po (minut nečinnosti, 0 = stále běží)">
            <input type="number" min={0} max={1440} value={ops.idleMinutes} onChange={(e) => setOps({ ...ops, idleMinutes: Number(e.target.value) })} className="field w-28" />
          </Field>
          <Field label="Disk (GB, jen zvětšit)">
            <input type="number" min={tenant.storageGb} max={500} value={ops.storageGb} onChange={(e) => setOps({ ...ops, storageGb: Number(e.target.value) })} className="field w-28" />
          </Field>
          <button disabled={busy || (ops.idleMinutes === tenant.idleMinutes && ops.storageGb === tenant.storageGb)} className="btn-secondary">
            Uložit
          </button>
        </form>
        <div className="mt-4 flex items-center gap-3">
          <h3 className="section-header flex-1">Zálohy</h3>
          <button disabled={busy} onClick={() => void run(() => api.admin.backup(id))} className="btn-link text-sm">
            Zálohovat teď
          </button>
        </div>
        <ul className="mt-1 text-xs text-fg-secondary">
          {tenant.backups.map((b) => (
            <li key={b.key}>
              {new Date(b.createdAt).toLocaleString("cs-CZ")} · {b.reason} · {fileSize(b.bytes)}
            </li>
          ))}
          {!tenant.backups.length && <li className="text-fg-muted">Zatím žádné. Záloha vzniká před každým uspáním a denně.</li>}
        </ul>
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
                <button
                  disabled={busy}
                  title="Pro uživatele, který ztratil telefon s ověřovací aplikací i záložní kódy"
                  onClick={() => window.confirm(`Vypnout dvoufázové ověření pro ${m.name ?? m.email}?`) && void run(() => api.admin.resetSecondFactor(m.userId))}
                  className="btn-link"
                >
                  Vypnout 2FA
                </button>
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
        {link && <LoginLink who={link.who} url={link.url} />}
        <InviteForm
          onInvite={(body) =>
            run(async () => {
              const result = await api.admin.invite(id, body);
              if (result.loginLink) setLink({ who: body.email, url: result.loginLink });
            })
          }
        />
        <p className="mt-1 text-xs text-fg-muted">Nový uživatel dostane jednorázový přihlašovací odkaz. Změny členství platí do minuty.</p>
      </section>

      {error && <p className="notice notice-error px-3 py-2 text-sm">{error}</p>}

      <section className="border-t border-line pt-6">
        <h2 className="section-header text-error">Odebrat tenanta</h2>
        <p className="mt-1 text-sm text-fg-secondary">
          Odebere tenanta z claimů všech uživatelů, takže nikdo z tenanta se už nepřihlásí. Kontejner se zastaví, disk a zálohy zůstanou zachované.
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

/**
 * The system admin's tenant administration in a modal (native `<dialog>`: Esc and the backdrop close it): the tenants
 * on the left, the chosen one's `TenantPanel` or the form for a new one on the right.
 */
export function TenantsDialog({
  tenants,
  initial,
  onChanged,
  onClose,
}: {
  tenants: TenantSummary[];
  /** The tenant to open, or `null` for the form of a new one. */
  initial?: string | null;
  /** A tenant was created, changed or deleted. */
  onChanged: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [selected, setSelected] = useState<string | null>(initial !== undefined ? initial : (tenants[0]?.id ?? null));
  useEffect(() => ref.current?.showModal(), []);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => e.target === ref.current && ref.current.close()}
      aria-label="Tenanti"
      className="m-auto h-[min(44rem,calc(100dvh-2rem))] w-[min(72rem,calc(100vw-2rem))] max-w-none overflow-hidden rounded-md border border-line bg-canvas p-0 text-fg shadow-[var(--shadow-popup)] backdrop:bg-black/50"
    >
      <div className="flex h-full">
        <nav className="flex w-60 shrink-0 flex-col border-r border-line bg-sidebar p-2 text-sm">
          <div className="flex items-center justify-between px-2 py-1">
            <h2 className="section-header">Tenanti</h2>
            <button onClick={() => ref.current?.close()} aria-label="Zavřít" className="list-row px-2 text-base leading-6 text-fg-secondary">
              ×
            </button>
          </div>
          <button onClick={() => setSelected(null)} data-active={selected === null} className="list-row mt-1 w-full px-2 py-1.5 text-left text-primary">
            + Založit tenanta
          </button>
          <div className="mt-1 min-h-0 flex-1 overflow-y-auto">
            {tenants.map((t) => (
              <button key={t.id} onClick={() => setSelected(t.id)} data-active={selected === t.id} className="list-row block w-full truncate px-2 py-1.5 text-left">
                {t.name} <span className="text-xs text-fg-muted">· {t.id}</span>
              </button>
            ))}
            {!tenants.length && <p className="px-2 py-1.5 text-fg-muted">Zatím žádní.</p>}
          </div>
        </nav>
        <div className="min-w-0 flex-1">
          {selected ? (
            <TenantPanel
              key={selected}
              id={selected}
              onChanged={onChanged}
              onDeleted={() => {
                setSelected(null);
                onChanged();
              }}
            />
          ) : (
            <NewTenant
              onCreated={(id) => {
                setSelected(id);
                onChanged();
              }}
            />
          )}
        </div>
      </div>
    </dialog>
  );
}
