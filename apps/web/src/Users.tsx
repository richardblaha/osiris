import type { AdminUser, Role, TenantSummary } from "@osiris/shared";
import { useEffect, useState, type FormEvent } from "react";
import { api } from "./api.ts";
import { Avatar } from "./Profile.tsx";
import { attempt, ErrorNotice, Field, Loading } from "./Scope.tsx";
import { LoginLink, roleLabel } from "./TenantInfo.tsx";
import { t } from "i18next";

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
      <nav className="relative flex w-72 shrink-0 flex-col border-e border-line p-2 text-sm">
        <Loading show={!users && !error} />
        <h2 className="section-header px-2 py-1">{t("users:title")}</h2>
        <ErrorNotice error={error} />
        <div className="mt-1 min-h-0 flex-1 overflow-y-auto">
          {users?.map((u) => (
            <button key={u.id} onClick={() => setSelected(u.id)} data-active={selected === u.id} className="list-row flex w-full items-center gap-2 px-2 py-1.5 text-start">
              <Avatar user={{ ...u, phone: null }} size={24} />
              <span className={`min-w-0 flex-1 ${u.disabled ? "text-fg-muted line-through" : ""}`}>
                <span className="block truncate">{u.name ?? u.email}</span>
                {u.name && <span className="block truncate text-xs text-fg-muted">{u.email}</span>}
              </span>
              {u.systemAdmin && <span className="badge badge-accent">{t("role.admin")}</span>}
            </button>
          ))}
          <button onClick={() => setSelected(null)} data-active={selected === null} className="list-row mt-1 w-full px-2 py-1.5 text-start text-primary">
            + {t("users:add")}
          </button>
        </div>
      </nav>
      <div className="min-w-0 flex-1">
        {selected === null ? (
          <NewUser onCreated={(id) => void load().then(() => setSelected(id))} />
        ) : user ? (
          <UserDetail key={user.id} user={user} self={user.id === self} tenants={tenants} onChanged={() => void load()} />
        ) : (
          <p className="detail text-sm text-fg-muted">{t("users:select")}</p>
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
        <h1 className="text-lg font-semibold">{t("users:added")}</h1>
        <LoginLink who={created.who} url={created.link} />
        <p className="mt-3 text-sm text-fg-secondary">{t("users:addToTenants")}</p>
        <button onClick={() => onCreated(created.id)} className="btn-primary mt-4">
          {t("users:openDetail")}
        </button>
      </div>
    );
  }
  return (
    <form onSubmit={submit} className="detail space-y-4">
      <h1 className="text-lg font-semibold">{t("users:new")}</h1>
      <Field label={t("profile:email")}>
        <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} className="field" />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t("invite:firstNameLabel")}>
          <input required value={firstName} onChange={(e) => setFirstName(e.target.value)} className="field" />
        </Field>
        <Field label={t("invite:lastNameLabel")}>
          <input value={lastName} onChange={(e) => setLastName(e.target.value)} className="field" />
        </Field>
      </div>
      <ErrorNotice error={error} />
      <button disabled={busy} className="btn-primary">
        {t("users:create")}
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
    void act(() => api.admin.updateUser(user.id, { firstName, lastName, ...(email !== (user.email ?? "") ? { email } : {}) }), t("savedNotice"));
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
            {self && ` · ${t("users:you")}`}
          </p>
        </div>
      </div>
      <ErrorNotice error={error} />
      {notice && <p className="notice px-3 py-2 text-sm">{notice}</p>}

      <form onSubmit={save} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label={t("invite:firstNameLabel")}>
            <input required value={firstName} onChange={(e) => setFirstName(e.target.value)} className="field" />
          </Field>
          <Field label={t("invite:lastNameLabel")}>
            <input value={lastName} onChange={(e) => setLastName(e.target.value)} className="field" />
          </Field>
        </div>
        <Field label={t("profile:email")}>
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} className="field" />
        </Field>
        <button disabled={busy} className="btn-primary">
          {t("save")}
        </button>
      </form>

      <section className="space-y-2 text-sm">
        <h2 className="section-header">{t("users:access")}</h2>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={user.systemAdmin}
            disabled={busy || self}
            onChange={(e) => void act(() => api.admin.updateUser(user.id, { systemAdmin: e.target.checked }))}
          />
          {t("role.systemAdminCap")} <span className="text-fg-muted">· {t("users:systemAdminHint")}</span>
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={user.disabled} disabled={busy || self} onChange={(e) => void act(() => api.admin.updateUser(user.id, { disabled: e.target.checked }))} />
          {t("users:blocked")} <span className="text-fg-muted">· {t("users:blockedHint")}</span>
        </label>
      </section>

      <section>
        <h2 className="section-header">{t("app:nav.tenants")}</h2>
        <ul className="mt-2 space-y-1 text-sm">
          {tenants.map((tenant) => (
            <li key={tenant.id} className="flex items-center gap-3">
              <span className="min-w-0 flex-1 truncate">
                {tenant.name} <span className="text-xs text-fg-muted">· {tenant.id}</span>
              </span>
              <select value={role(tenant.id)} disabled={busy} onChange={(e) => setRole(tenant.id, e.target.value as Role | "")} className="field w-auto">
                <option value="">{t("users:noAccess")}</option>
                <option value="member">{roleLabel("member")}</option>
                <option value="admin">{roleLabel("admin")}</option>
              </select>
            </li>
          ))}
        </ul>
        {!tenants.length && <p className="mt-2 text-sm text-fg-muted">{t("users:noTenants")}</p>}
      </section>

      <section>
        <h2 className="section-header">{t("users:signIn")}</h2>
        <div className="mt-2 flex flex-wrap gap-2">
          <button disabled={busy || user.disabled} onClick={() => void attempt(setBusy, setError, async () => setLink((await api.admin.loginLink(user.id)).loginLink))} className="btn-secondary">
            {t("users:createLink")}
          </button>
          <button disabled={busy} onClick={() => void act(() => api.admin.resetSecondFactor(user.id), t("users:twoFactorOff"))} className="btn-secondary">
            {t("tenants:reset2fa")}
          </button>
        </div>
        {link && <LoginLink who={user.name ?? user.email ?? user.id} url={link} />}
      </section>
    </div>
  );
}
