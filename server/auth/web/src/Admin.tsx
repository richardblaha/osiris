import { t } from "i18next";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api, type Client, type ClientInput, type ScimGroup, type ScimUser } from "./api.ts";
import { compareText, formatDateTime } from "./i18n.ts";
import { attempt, ErrorNotice, Field, Pending } from "./ui.tsx";

type Section = "users" | "groups" | "apps" | "keys";
const SECTIONS: Section[] = ["users", "groups", "apps", "keys"];
const sectionOf = (path: string): Section => SECTIONS.find((s) => path.startsWith(`/admin/${s}`)) ?? "users";

/** Administration: users, groups, applications and API keys (members of the admin group). */
export function Admin() {
  const [section, setSection] = useState<Section>(sectionOf(location.pathname));
  const go = (s: Section) => {
    history.replaceState(null, "", `/admin/${s}`);
    setSection(s);
  };
  return (
    <div className="space-y-6">
      <nav className="flex flex-wrap gap-2" aria-label={t("admin:title")}>
        {SECTIONS.map((s) => (
          <button key={s} onClick={() => go(s)} className={s === section ? "btn-primary text-sm" : "btn-secondary text-sm"} aria-current={s === section ? "page" : undefined}>
            {t(`admin:sections.${s}`)}
          </button>
        ))}
      </nav>
      {section === "users" ? <Users /> : section === "groups" ? <Groups /> : section === "apps" ? <Apps /> : <Keys />}
    </div>
  );
}

/** A list on the left, the selected item (or a new one) on the right. */
function Split({ list, detail }: { list: ReactNode; detail: ReactNode }) {
  return (
    <div className="grid gap-6 md:grid-cols-[18rem_1fr]">
      <div className="space-y-3">{list}</div>
      <div className="detail min-w-0">{detail}</div>
    </div>
  );
}

const Item = ({ active, onClick, title, sub }: { active: boolean; onClick: () => void; title: string; sub?: string }) => (
  <li>
    <button onClick={onClick} aria-current={active ? "true" : undefined} className={`w-full rounded-md px-3 py-2 text-left text-sm ${active ? "bg-primary-soft" : "hover:bg-surface-hover"}`}>
      <span className="block truncate font-medium">{title}</span>
      {sub && <span className="block truncate text-xs text-fg-muted">{sub}</span>}
    </button>
  </li>
);

/** Something shown once (a secret, a key, a sign-in link), with a copy button. */
function ShownOnce({ label, value }: { label: string; value: string }) {
  return (
    <div className="notice space-y-2 px-3 py-3 text-sm">
      <p>{label}</p>
      <code className="block break-all font-mono">{value}</code>
      <button type="button" className="btn-secondary text-sm" onClick={() => void navigator.clipboard?.writeText(value)}>
        {t("copy")}
      </button>
    </div>
  );
}

const userName = (u: ScimUser) => [u.name.givenName, u.name.familyName].filter(Boolean).join(" ") || u.userName;

// --- users ------------------------------------------------------------------------------------------------------------

function Users() {
  const [users, setUsers] = useState<ScimUser[]>();
  const [groups, setGroups] = useState<ScimGroup[]>([]);
  const [selected, setSelected] = useState<string | "new">();
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string>();
  const load = () => Promise.all([api.admin.users(), api.admin.groups()]).then(([u, g]) => (setUsers(u), setGroups(g)), (e: Error) => setError(e.message));
  useEffect(() => void load(), []);
  if (!users) return <Pending error={error} />;
  const shown = users.filter((u) => `${userName(u)} ${u.userName}`.toLowerCase().includes(query.toLowerCase())).sort((a, b) => compareText(userName(a), userName(b)));
  const user = users.find((u) => u.id === selected);
  return (
    <Split
      list={
        <>
          <button className="btn-primary w-full text-sm" onClick={() => setSelected("new")}>
            {t("admin:users.add")}
          </button>
          <input className="field" type="search" placeholder={t("admin:search")} value={query} onChange={(e) => setQuery(e.target.value)} aria-label={t("admin:search")} />
          <ul className="space-y-1">
            {shown.map((u) => (
              <Item key={u.id} active={u.id === selected} onClick={() => setSelected(u.id)} title={userName(u)} sub={`${u.userName}${u.active ? "" : ` · ${t("admin:users.blocked")}`}`} />
            ))}
          </ul>
        </>
      }
      detail={
        selected === "new" ? (
          <NewUser onCreated={async (id) => (await load(), setSelected(id))} />
        ) : user ? (
          <UserDetail key={user.id} user={user} groups={groups} onChange={load} onDeleted={async () => (await load(), setSelected(undefined))} />
        ) : (
          <p className="text-sm text-fg-muted">{t("admin:select")}</p>
        )
      }
    />
  );
}

function NewUser({ onCreated }: { onCreated: (id: string) => Promise<unknown> }) {
  const [form, setForm] = useState({ email: "", firstName: "", lastName: "" });
  const [link, setLink] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void attempt(setBusy, setError, async () => {
      const user = await api.admin.createUser(form);
      setLink(await api.admin.signInLink(user.id));
      await onCreated(user.id);
    });
  };
  if (link) return <ShownOnce label={t("admin:users.linkHint")} value={link} />;
  return (
    <form onSubmit={submit} className="max-w-md space-y-4">
      <h2 className="text-lg font-semibold">{t("admin:users.add")}</h2>
      <Field label={t("email")}>
        <input className="field" type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
      </Field>
      <Field label={t("firstName")}>
        <input className="field" required value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} />
      </Field>
      <Field label={t("lastName")}>
        <input className="field" value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} />
      </Field>
      <ErrorNotice error={error} />
      <button className="btn-primary" disabled={busy}>
        {t("admin:users.create")}
      </button>
    </form>
  );
}

function UserDetail({ user, groups, onChange, onDeleted }: { user: ScimUser; groups: ScimGroup[]; onChange: () => Promise<unknown>; onDeleted: () => Promise<unknown> }) {
  const [form, setForm] = useState({ firstName: user.name.givenName ?? "", lastName: user.name.familyName ?? "", email: user.emails[0]?.value ?? "" });
  const [link, setLink] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const act = (action: () => Promise<unknown>, done?: string) =>
    attempt(setBusy, setError, async () => {
      setNotice(undefined);
      await action();
      await onChange();
      if (done) setNotice(done);
    });
  const save = (e: FormEvent) => {
    e.preventDefault();
    void act(() => api.admin.updateUser(user.id, { name: { givenName: form.firstName, familyName: form.lastName }, userName: form.email, emails: [{ value: form.email, primary: true }] }), t("saved"));
  };
  const member = new Set(user.groups.map((g) => g.value));
  return (
    <div className="space-y-6">
      <form onSubmit={save} className="max-w-md space-y-4">
        <h2 className="text-lg font-semibold">{userName(user)}</h2>
        <Field label={t("firstName")}>
          <input className="field" required value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} />
        </Field>
        <Field label={t("lastName")}>
          <input className="field" value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} />
        </Field>
        <Field label={t("email")}>
          <input className="field" type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </Field>
        {user.phoneNumbers[0] && <p className="text-sm text-fg-secondary">{t("admin:users.phone", { phone: user.phoneNumbers[0].value })}</p>}
        <button className="btn-primary" disabled={busy}>
          {t("save")}
        </button>
      </form>

      <section className="space-y-2">
        <h3 className="section-header">{t("admin:sections.groups")}</h3>
        {!groups.length && <p className="text-sm text-fg-muted">{t("admin:groups.none")}</p>}
        <ul className="grid gap-1 sm:grid-cols-2">
          {groups.map((g) => (
            <li key={g.id}>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={member.has(g.id)} disabled={busy} onChange={(e) => void act(() => (e.target.checked ? api.admin.addMember(g.id, user.id) : api.admin.removeMember(g.id, user.id)))} />
                <span className="font-mono">{g.id}</span>
              </label>
            </li>
          ))}
        </ul>
      </section>

      <section className="flex flex-wrap gap-2">
        <button className="btn-secondary text-sm" disabled={busy || !user.active} onClick={() => void attempt(setBusy, setError, async () => setLink(await api.admin.signInLink(user.id)))}>
          {t("admin:users.link")}
        </button>
        <button className="btn-secondary text-sm" disabled={busy} onClick={() => void act(() => api.admin.resetSecondFactor(user.id), t("admin:users.secondFactorReset"))}>
          {t("admin:users.resetSecondFactor")}
        </button>
        <button className="btn-secondary text-sm" disabled={busy} onClick={() => void act(() => api.admin.updateUser(user.id, { active: !user.active }))}>
          {user.active ? t("admin:users.block") : t("admin:users.unblock")}
        </button>
        <button
          className="btn-danger text-sm"
          disabled={busy}
          onClick={() => confirm(t("admin:users.deleteConfirm", { name: userName(user) })) && void attempt(setBusy, setError, async () => (await api.admin.deleteUser(user.id), await onDeleted()))}
        >
          {t("delete")}
        </button>
      </section>
      {link && <ShownOnce label={t("admin:users.linkHint")} value={link} />}
      {notice && <p className="notice px-3 py-2 text-sm">{notice}</p>}
      <ErrorNotice error={error} />
    </div>
  );
}

// --- groups -----------------------------------------------------------------------------------------------------------

function Groups() {
  const [groups, setGroups] = useState<ScimGroup[]>();
  const [users, setUsers] = useState<ScimUser[]>([]);
  const [selected, setSelected] = useState<string>();
  const [name, setName] = useState("");
  const [adding, setAdding] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const load = () => Promise.all([api.admin.groups(), api.admin.users()]).then(([g, u]) => (setGroups(g), setUsers(u)), (e: Error) => setError(e.message));
  useEffect(() => void load(), []);
  if (!groups) return <Pending error={error} />;
  const act = (action: () => Promise<unknown>) => attempt(setBusy, setError, async () => (await action(), await load()));
  const group = groups.find((g) => g.id === selected);
  const byId = new Map(users.map((u) => [u.id, u]));
  const create = (e: FormEvent) => {
    e.preventDefault();
    void act(async () => {
      await api.admin.createGroup(name.trim());
      setSelected(name.trim());
      setName("");
    });
  };
  return (
    <Split
      list={
        <>
          <form onSubmit={create} className="flex gap-2">
            <input className="field" required pattern="[a-z0-9][a-z0-9:._\-]{0,99}" placeholder={t("admin:groups.name")} aria-label={t("admin:groups.name")} value={name} onChange={(e) => setName(e.target.value)} />
            <button className="btn-primary text-sm" disabled={busy}>
              {t("add")}
            </button>
          </form>
          <ul className="space-y-1">
            {groups.map((g) => (
              <Item key={g.id} active={g.id === selected} onClick={() => setSelected(g.id)} title={g.id} sub={t("admin:groups.members", { count: g.members.length })} />
            ))}
          </ul>
          <ErrorNotice error={error} />
        </>
      }
      detail={
        group ? (
          <div className="space-y-4">
            <h2 className="font-mono text-lg font-semibold">{group.id}</h2>
            <ul className="divide-y divide-line">
              {group.members.map((m) => (
                <li key={m.value} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <span>{byId.get(m.value) ? userName(byId.get(m.value)!) : m.value}</span>
                  <button className="btn-secondary text-sm" disabled={busy} onClick={() => void act(() => api.admin.removeMember(group.id, m.value))}>
                    {t("remove")}
                  </button>
                </li>
              ))}
            </ul>
            <div className="flex gap-2">
              <select className="field" value={adding} onChange={(e) => setAdding(e.target.value)} aria-label={t("admin:groups.addMember")}>
                <option value="">{t("admin:groups.addMember")}</option>
                {users.filter((u) => !group.members.some((m) => m.value === u.id)).map((u) => (
                  <option key={u.id} value={u.id}>
                    {userName(u)} ({u.userName})
                  </option>
                ))}
              </select>
              <button className="btn-primary text-sm" disabled={busy || !adding} onClick={() => void act(async () => (await api.admin.addMember(group.id, adding), setAdding("")))}>
                {t("add")}
              </button>
            </div>
            <button className="btn-danger text-sm" disabled={busy} onClick={() => confirm(t("admin:groups.deleteConfirm", { name: group.id })) && void act(async () => (await api.admin.deleteGroup(group.id), setSelected(undefined)))}>
              {t("delete")}
            </button>
          </div>
        ) : (
          <p className="text-sm text-fg-muted">{t("admin:select")}</p>
        )
      }
    />
  );
}

// --- applications -----------------------------------------------------------------------------------------------------

const EMPTY: ClientInput = { name: "", logo: null, type: "web", confidential: true, redirectUris: [], postLogoutRedirectUris: [], allowedGroups: [], acceptsTokensOf: [] };
const lines = (text: string) => text.split(/\s+/).map((s) => s.trim()).filter(Boolean);

function Apps() {
  const [clients, setClients] = useState<Client[]>();
  const [groups, setGroups] = useState<ScimGroup[]>([]);
  const [selected, setSelected] = useState<string | "new">();
  const [error, setError] = useState<string>();
  const load = () => Promise.all([api.admin.clients(), api.admin.groups()]).then(([c, g]) => (setClients(c), setGroups(g)), (e: Error) => setError(e.message));
  useEffect(() => void load(), []);
  if (!clients) return <Pending error={error} />;
  const client = clients.find((c) => c.id === selected);
  return (
    <Split
      list={
        <>
          <button className="btn-primary w-full text-sm" onClick={() => setSelected("new")}>
            {t("admin:apps.add")}
          </button>
          <ul className="space-y-1">
            {clients.map((c) => (
              <Item key={c.id} active={c.id === selected} onClick={() => setSelected(c.id)} title={c.name} sub={c.id} />
            ))}
          </ul>
          <Discovery />
        </>
      }
      detail={
        selected === "new" || client ? (
          <AppForm key={selected} client={client} clients={clients} groups={groups} onSaved={async (id) => (await load(), setSelected(id))} onDeleted={async () => (await load(), setSelected(undefined))} />
        ) : (
          <p className="text-sm text-fg-muted">{t("admin:select")}</p>
        )
      }
    />
  );
}

/** What an app's developer needs: the issuer and its discovery document. */
const Discovery = () => (
  <div className="space-y-1 text-xs text-fg-secondary">
    <p className="section-header">{t("admin:apps.issuer")}</p>
    <code className="block break-all">{location.origin}</code>
    <a className="btn-link break-all" href="/.well-known/openid-configuration">
      /.well-known/openid-configuration
    </a>
  </div>
);

function AppForm({ client, clients, groups, onSaved, onDeleted }: { client?: Client; clients: Client[]; groups: ScimGroup[]; onSaved: (id: string) => Promise<unknown>; onDeleted: () => Promise<unknown> }) {
  const [id, setId] = useState(client?.id ?? "");
  const [form, setForm] = useState<ClientInput>(client ?? EMPTY);
  const [uris, setUris] = useState({ redirect: (client?.redirectUris ?? []).join("\n"), logout: (client?.postLogoutRedirectUris ?? []).join("\n") });
  const [secret, setSecret] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const toggle = (list: string[], value: string, on: boolean) => (on ? [...list, value] : list.filter((v) => v !== value));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void attempt(setBusy, setError, async () => {
      const input = { ...form, logo: form.logo || null, redirectUris: lines(uris.redirect), postLogoutRedirectUris: lines(uris.logout) };
      const saved = client ? await api.admin.updateClient(client.id, input) : await api.admin.createClient(id.trim(), input);
      setSecret(saved.secret);
      await onSaved(saved.client.id);
    });
  };
  return (
    <form onSubmit={submit} className="max-w-xl space-y-4">
      <h2 className="text-lg font-semibold">{client ? client.name : t("admin:apps.add")}</h2>
      {secret && <ShownOnce label={t("admin:apps.secretHint")} value={secret} />}
      <Field label={t("admin:apps.id")}>
        <input className="field font-mono" required disabled={!!client} pattern="[a-z0-9][a-z0-9._\-]{1,63}" value={id} onChange={(e) => setId(e.target.value)} />
      </Field>
      <Field label={t("admin:apps.name")}>
        <input className="field" required maxLength={100} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      </Field>
      <Field label={t("admin:apps.logo")}>
        <input className="field" type="url" value={form.logo ?? ""} onChange={(e) => setForm({ ...form, logo: e.target.value })} />
      </Field>
      <div className="flex flex-wrap gap-4 text-sm">
        <label className="flex items-center gap-2">
          <select className="field w-auto" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as Client["type"] })}>
            <option value="web">{t("admin:apps.web")}</option>
            <option value="native">{t("admin:apps.native")}</option>
          </select>
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={form.confidential} onChange={(e) => setForm({ ...form, confidential: e.target.checked })} />
          {t("admin:apps.confidential")}
        </label>
      </div>
      <Field label={t("admin:apps.redirectUris")}>
        <textarea className="field font-mono text-sm" rows={3} value={uris.redirect} onChange={(e) => setUris({ ...uris, redirect: e.target.value })} />
      </Field>
      <Field label={t("admin:apps.logoutUris")}>
        <textarea className="field font-mono text-sm" rows={2} value={uris.logout} onChange={(e) => setUris({ ...uris, logout: e.target.value })} />
      </Field>
      <fieldset className="space-y-1">
        <legend className="section-header">{t("admin:apps.allowedGroups")}</legend>
        <p className="text-xs text-fg-muted">{t("admin:apps.allowedGroupsHint")}</p>
        {groups.map((g) => (
          <label key={g.id} className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={form.allowedGroups.includes(g.id)} onChange={(e) => setForm({ ...form, allowedGroups: toggle(form.allowedGroups, g.id, e.target.checked) })} />
            <span className="font-mono">{g.id}</span>
          </label>
        ))}
      </fieldset>
      <fieldset className="space-y-1">
        <legend className="section-header">{t("admin:apps.acceptsTokensOf")}</legend>
        <p className="text-xs text-fg-muted">{t("admin:apps.acceptsTokensOfHint")}</p>
        {clients.filter((c) => c.id !== client?.id).map((c) => (
          <label key={c.id} className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={form.acceptsTokensOf.includes(c.id)} onChange={(e) => setForm({ ...form, acceptsTokensOf: toggle(form.acceptsTokensOf, c.id, e.target.checked) })} />
            {c.name} <span className="font-mono text-fg-muted">{c.id}</span>
          </label>
        ))}
      </fieldset>
      <ErrorNotice error={error} />
      <div className="flex flex-wrap gap-2">
        <button className="btn-primary" disabled={busy}>
          {t("save")}
        </button>
        {client?.confidential && (
          <button type="button" className="btn-secondary" disabled={busy} onClick={() => confirm(t("admin:apps.rotateConfirm")) && void attempt(setBusy, setError, async () => setSecret(await api.admin.rotateSecret(client.id)))}>
            {t("admin:apps.rotate")}
          </button>
        )}
        {client && (
          <button type="button" className="btn-danger" disabled={busy} onClick={() => confirm(t("admin:apps.deleteConfirm", { name: client.name })) && void attempt(setBusy, setError, async () => (await api.admin.deleteClient(client.id), await onDeleted()))}>
            {t("delete")}
          </button>
        )}
      </div>
    </form>
  );
}

// --- API keys ---------------------------------------------------------------------------------------------------------

function Keys() {
  const [keys, setKeys] = useState<{ name: string; createdAt: number }[]>();
  const [name, setName] = useState("");
  const [token, setToken] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const load = () => api.admin.tokens().then(setKeys, (e: Error) => setError(e.message));
  useEffect(() => void load(), []);
  if (!keys) return <Pending error={error} />;
  const create = (e: FormEvent) => {
    e.preventDefault();
    void attempt(setBusy, setError, async () => {
      setToken(await api.admin.createToken(name.trim()));
      setName("");
      await load();
    });
  };
  return (
    <div className="max-w-2xl space-y-4">
      <p className="text-sm text-fg-secondary">{t("admin:keys.intro")}</p>
      <form onSubmit={create} className="flex gap-2">
        <input className="field" required pattern="[a-z0-9\-]{1,40}" placeholder={t("admin:keys.name")} aria-label={t("admin:keys.name")} value={name} onChange={(e) => setName(e.target.value)} />
        <button className="btn-primary text-sm" disabled={busy}>
          {t("add")}
        </button>
      </form>
      {token && <ShownOnce label={t("admin:keys.tokenHint")} value={token} />}
      <ul className="divide-y divide-line">
        {keys.map((k) => (
          <li key={k.name} className="flex items-center justify-between gap-3 py-2 text-sm">
            <span>
              <span className="font-mono">{k.name}</span> <span className="text-fg-muted">· {formatDateTime(k.createdAt)}</span>
            </span>
            <button className="btn-danger text-sm" disabled={busy} onClick={() => confirm(t("admin:keys.deleteConfirm", { name: k.name })) && void attempt(setBusy, setError, async () => (await api.admin.deleteToken(k.name), await load()))}>
              {t("delete")}
            </button>
          </li>
        ))}
      </ul>
      <ErrorNotice error={error} />
    </div>
  );
}
