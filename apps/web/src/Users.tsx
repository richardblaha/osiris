import type { AdminUser, Role, TenantSummary } from "@osiris/shared";
import { useEffect, useState, type FormEvent } from "react";
import { api } from "./api.ts";
import { Avatar } from "./Profile.tsx";
import { attempt, ErrorNotice, Field, Loading } from "./Scope.tsx";
import { LoginLink, roleLabel } from "./TenantInfo.tsx";

/** The system admin's user administration: everyone on the left, the chosen user's detail or a new user on the right. */
export function UserAdmin({ self, tenants }: { self: string; tenants: TenantSummary[] }) {
  const [users, setUsers] = useState<AdminUser[]>();
  const [selected, setSelected] = useState<string | null>();
  const [error, setError] = useState<string>();
  const load = () => api.admin.users().then(setUsers, (e: Error) => setError(e.message));
  useEffect(() => void load(), []);
  const user = users?.find((u) => u.id === selected);

  return (
    <div className="flex h-full">
      <nav className="relative flex w-72 shrink-0 flex-col border-r border-line p-2 text-sm">
        <Loading show={!users && !error} />
        <h2 className="section-header px-2 py-1">Správa uživatelů</h2>
        <button onClick={() => setSelected(null)} data-active={selected === null} className="list-row mt-1 w-full px-2 py-1.5 text-left text-primary">
          + Přidat uživatele
        </button>
        <ErrorNotice error={error} />
        <div className="mt-1 min-h-0 flex-1 overflow-y-auto">
          {users?.map((u) => (
            <button key={u.id} onClick={() => setSelected(u.id)} data-active={selected === u.id} className="list-row flex w-full items-center gap-2 px-2 py-1.5 text-left">
              <Avatar user={{ ...u, phone: null }} size={24} />
              <span className={`min-w-0 flex-1 ${u.disabled ? "text-fg-muted line-through" : ""}`}>
                <span className="block truncate">{u.name ?? u.email}</span>
                {u.name && <span className="block truncate text-xs text-fg-muted">{u.email}</span>}
              </span>
              {u.systemAdmin && <span className="badge badge-accent">správce</span>}
            </button>
          ))}
        </div>
      </nav>
      <div className="min-w-0 flex-1">
        {selected === null ? (
          <NewUser onCreated={(id) => void load().then(() => setSelected(id))} />
        ) : user ? (
          <UserDetail key={user.id} user={user} self={user.id === self} tenants={tenants} onChanged={() => void load()} />
        ) : (
          <p className="detail text-sm text-fg-muted">Vyber uživatele vlevo.</p>
        )}
      </div>
    </div>
  );
}

function NewUser({ onCreated }: { onCreated: (id: string) => void }) {
  const [email, setEmail] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [created, setCreated] = useState<{ id: string; who: string; link: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void attempt(setBusy, setError, async () => {
      const { userId, loginLink } = await api.admin.createUser({ email, firstName, lastName });
      setCreated({ id: userId, who: email, link: loginLink });
    });
  };

  if (created) {
    return (
      <div className="detail">
        <h1 className="text-lg font-semibold">Uživatel přidán</h1>
        <LoginLink who={created.who} url={created.link} />
        <p className="mt-3 text-sm text-fg-secondary">Do tenantů ho přidáš v jeho detailu.</p>
        <button onClick={() => onCreated(created.id)} className="btn-primary mt-4">
          Otevřít detail
        </button>
      </div>
    );
  }
  return (
    <form onSubmit={submit} className="detail space-y-4">
      <h1 className="text-lg font-semibold">Nový uživatel</h1>
      <Field label="E-mail">
        <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} className="field" />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Jméno">
          <input required value={firstName} onChange={(e) => setFirstName(e.target.value)} className="field" />
        </Field>
        <Field label="Příjmení">
          <input value={lastName} onChange={(e) => setLastName(e.target.value)} className="field" />
        </Field>
      </div>
      <ErrorNotice error={error} />
      <button disabled={busy} className="btn-primary">
        Přidat a vytvořit přihlašovací odkaz
      </button>
    </form>
  );
}

function UserDetail({ user, self, tenants, onChanged }: { user: AdminUser; self: boolean; tenants: TenantSummary[]; onChanged: () => void }) {
  const [firstName, setFirstName] = useState(user.firstName);
  const [lastName, setLastName] = useState(user.lastName);
  const [email, setEmail] = useState(user.email ?? "");
  const [link, setLink] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const act = (action: () => Promise<unknown>, done?: string) =>
    attempt(setBusy, setError, async () => {
      setNotice(undefined);
      await action();
      if (done) setNotice(done);
      onChanged();
    });

  const save = (e: FormEvent) => {
    e.preventDefault();
    void act(() => api.admin.updateUser(user.id, { firstName, lastName, ...(email !== (user.email ?? "") ? { email } : {}) }), "Uloženo.");
  };
  const role = (tenant: string) => user.tenants.find((t) => t.id === tenant)?.role ?? "";
  const setRole = (tenant: string, value: Role | "") =>
    void act(() => (value ? api.admin.setMember(tenant, user.id, value) : api.admin.removeMember(tenant, user.id)));

  return (
    <div className="detail space-y-8">
      <div className="flex items-center gap-3">
        <Avatar user={{ ...user, phone: null }} size={48} />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-lg font-semibold">{user.name ?? user.email}</h1>
          <p className="text-xs text-fg-muted">
            {user.id}
            {self && " · to jsi ty"}
          </p>
        </div>
      </div>
      <ErrorNotice error={error} />
      {notice && <p className="notice px-3 py-2 text-sm">{notice}</p>}

      <form onSubmit={save} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Jméno">
            <input required value={firstName} onChange={(e) => setFirstName(e.target.value)} className="field" />
          </Field>
          <Field label="Příjmení">
            <input value={lastName} onChange={(e) => setLastName(e.target.value)} className="field" />
          </Field>
        </div>
        <Field label="E-mail">
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} className="field" />
        </Field>
        <button disabled={busy} className="btn-primary">
          Uložit
        </button>
      </form>

      <section className="space-y-2 text-sm">
        <h2 className="section-header">Přístup</h2>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={user.systemAdmin}
            disabled={busy || self}
            onChange={(e) => void act(() => api.admin.updateUser(user.id, { systemAdmin: e.target.checked }))}
          />
          Správce systému <span className="text-fg-muted">· spravuje tenanty a uživatele, je správcem každého tenanta</span>
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={user.disabled} disabled={busy || self} onChange={(e) => void act(() => api.admin.updateUser(user.id, { disabled: e.target.checked }))} />
          Zablokovaný <span className="text-fg-muted">· nepřihlásí se a jeho přihlášení přestane platit do minuty</span>
        </label>
      </section>

      <section>
        <h2 className="section-header">Tenanti</h2>
        <ul className="mt-2 space-y-1 text-sm">
          {tenants.map((t) => (
            <li key={t.id} className="flex items-center gap-3">
              <span className="min-w-0 flex-1 truncate">
                {t.name} <span className="text-xs text-fg-muted">· {t.id}</span>
              </span>
              <select value={role(t.id)} disabled={busy} onChange={(e) => setRole(t.id, e.target.value as Role | "")} className="field w-auto">
                <option value="">bez přístupu</option>
                <option value="member">{roleLabel("member")}</option>
                <option value="admin">{roleLabel("admin")}</option>
              </select>
            </li>
          ))}
        </ul>
        {!tenants.length && <p className="mt-2 text-sm text-fg-muted">Zatím žádní tenanti.</p>}
      </section>

      <section>
        <h2 className="section-header">Přihlášení</h2>
        <div className="mt-2 flex flex-wrap gap-2">
          <button disabled={busy || user.disabled} onClick={() => void attempt(setBusy, setError, async () => setLink((await api.admin.loginLink(user.id)).loginLink))} className="btn-secondary">
            Vytvořit přihlašovací odkaz
          </button>
          <button disabled={busy} onClick={() => void act(() => api.admin.resetSecondFactor(user.id), "Dvoufázové ověření je vypnuté.")} className="btn-secondary">
            Vypnout 2FA
          </button>
        </div>
        {link && <LoginLink who={user.name ?? user.email ?? user.id} url={link} />}
      </section>
    </div>
  );
}
