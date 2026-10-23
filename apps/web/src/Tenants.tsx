import { FEATURES, type DirectoryUser, type Feature, type Role, type TenantDetail, type TenantSummary } from "@osiris/shared";
import { useEffect, useState, type FormEvent } from "react";
import { api } from "./api.ts";
import { InviteForm } from "./Invite.tsx";
import { attempt, ErrorNotice, Field, Pending } from "./Scope.tsx";
import { LoginLink } from "./TenantInfo.tsx";
import { fileSize } from "./Files.tsx";
import { QuotaForm } from "./Quotas.tsx";
import { t } from "i18next";
import { Trans } from "react-i18next";
import { formatDateTime, initial } from "./i18n.ts";

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Each feature's name and what it does, in the current language. */
export const featureLabels = (): Record<Feature, { label: string; hint: string }> =>
  Object.fromEntries(FEATURES.map((f) => [f, { label: t(`tenants:features.${f}.label`), hint: t(`tenants:features.${f}.hint`) }])) as Record<Feature, { label: string; hint: string }>;

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
      <h1 className="text-lg font-semibold">{t("tenants:new")}</h1>
      <p className="mt-1 text-sm text-fg-secondary">
        <Trans ns="tenants" i18nKey="newIntro" values={{ slug: t("tenants:slugToken") }} components={{ code: <code /> }} />
      </p>
      <form onSubmit={create} className="mt-6 space-y-4">
        <Field label={t("tenants:slug")}>
          <input
            value={id}
            onChange={(e) => setId(e.target.value.toLowerCase())}
            placeholder={t("tenants:slugPlaceholder")}
            pattern={SLUG.source}
            title={t("tenants:slugHint")}
            maxLength={40}
            required
            className="field"
          />
        </Field>
        <Field label={t("name")}>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("tenants:namePlaceholder")} required className="field" />
        </Field>
        <button disabled={busy} className="btn-primary">
          {busy ? t("tenants:creating") : t("tenants:create")}
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

  if (!tenant) return <Pending error={error} className="relative h-full" />;
  const memberIds = new Set(tenant.memberList.map((m) => m.userId));
  const candidates = users.filter((u) => !memberIds.has(u.id));
  const labels = featureLabels();

  return (
    <div className="detail space-y-8">
      <h1 className="text-lg font-semibold">{tenant.name}</h1>
      <section>
        <h2 className="section-header">{t("name")}</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => api.admin.updateTenant(id, { name }));
          }}
          className="mt-2 flex gap-2"
        >
          <input value={name} onChange={(e) => setName(e.target.value)} required className="field min-w-0 flex-1" />
          <button disabled={busy || name === tenant.name} className="btn-secondary">
            {t("tenants:rename")}
          </button>
        </form>
        <p className="mt-1 text-xs text-fg-muted">{t("tenants:slugValue", { id: tenant.id })}</p>
      </section>

      <section>
        <h2 className="section-header">{t("tenants:features.title")}</h2>
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
                {labels[f].label} <span className="text-fg-muted">· {labels[f].hint}</span>
              </span>
            </label>
          ))}
        </div>
      </section>

      <section>
        <h2 className="section-header">{t("tenants:operation")}</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => api.admin.updateTenant(id, ops));
          }}
          className="mt-2 flex flex-wrap items-end gap-3"
        >
          <Field label={t("tenants:idle")}>
            <input type="number" min={0} max={1440} value={ops.idleMinutes} onChange={(e) => setOps({ ...ops, idleMinutes: Number(e.target.value) })} className="field w-28" />
          </Field>
          <Field label={t("tenants:disk")}>
            <input type="number" min={tenant.storageGb} max={500} value={ops.storageGb} onChange={(e) => setOps({ ...ops, storageGb: Number(e.target.value) })} className="field w-28" />
          </Field>
          <button disabled={busy || (ops.idleMinutes === tenant.idleMinutes && ops.storageGb === tenant.storageGb)} className="btn-secondary">
            {t("save")}
          </button>
        </form>
        <h3 className="section-header mt-4">{t("tenants:quotas")}</h3>
        <p className="mt-1 text-xs text-fg-muted">{t("tenants:quotasHint")}</p>
        <QuotaForm key={JSON.stringify(tenant.quotas)} quotas={tenant.quotas} busy={busy} onSave={(quotas) => void run(() => api.admin.updateTenant(id, { quotas }))} />
        <WebSitesForm key={tenant.webSites.join()} sites={tenant.webSites} busy={busy} onSave={(webSites) => void run(() => api.admin.updateTenant(id, { webSites }))} />
        <div className="mt-4 flex items-center gap-3">
          <h3 className="section-header flex-1">{t("tenants:backups")}</h3>
          <button disabled={busy} onClick={() => void run(() => api.admin.backup(id))} className="btn-link text-sm">
            {t("tenants:backupNow")}
          </button>
        </div>
        <ul className="mt-1 text-xs text-fg-secondary">
          {tenant.backups.map((b) => (
            <li key={b.key}>
              {formatDateTime(b.createdAt)} · {b.reason} · {fileSize(b.bytes)}
            </li>
          ))}
          {!tenant.backups.length && <li className="text-fg-muted">{t("tenants:noBackups")}</li>}
        </ul>
      </section>

      <section>
        <h2 className="section-header">{t("app:nav.users")}</h2>
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
                  <option value="member">{t("role.member")}</option>
                  <option value="admin">{t("role.admin")}</option>
                </select>
                <button
                  disabled={busy}
                  title={t("tenants:reset2faHint")}
                  onClick={() => window.confirm(t("tenants:reset2faConfirm", { name: m.name ?? m.email })) && void run(() => api.admin.resetSecondFactor(m.userId))}
                  className="btn-link"
                >
                  {t("tenants:reset2fa")}
                </button>
                <button disabled={busy} onClick={() => void run(() => api.admin.removeMember(id, m.userId))} className="btn-danger">
                  {t("remove")}
                </button>
              </span>
            </li>
          ))}
          {!tenant.memberList.length && <li className="py-2 text-sm text-fg-muted">{t("tenants:noMembers")}</li>}
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
            <option value="">{t("tenants:addUser")}</option>
            {candidates.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name ?? u.email ?? u.id}
                {u.name && u.email ? ` (${u.email})` : ""}
              </option>
            ))}
          </select>
          <select value={newRole} onChange={(e) => setNewRole(e.target.value as Role)} className="field w-auto">
            <option value="member">{t("role.member")}</option>
            <option value="admin">{t("role.admin")}</option>
          </select>
          <button disabled={busy || !newUser} className="btn-primary">
            {t("add")}
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
        <p className="mt-1 text-xs text-fg-muted">{t("tenants:inviteHint")}</p>
      </section>

      {error && <p className="notice notice-error px-3 py-2 text-sm">{error}</p>}

      <section className="border-t border-line pt-6">
        <h2 className="section-header text-error">{t("tenants:remove")}</h2>
        <p className="mt-1 text-sm text-fg-secondary">
          {t("tenants:removeHint")}
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
          <input value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder={t("tenants:removeConfirm", { id: tenant.id })} className="field min-w-0 flex-1" />
          <button disabled={busy || confirm !== tenant.id} className="btn-danger">
            {t("remove")}
          </button>
        </form>
      </section>
    </div>
  );
}

/** The system admin's tenant administration: the tenants on the left, the chosen one's `TenantPanel` or the form for a new one on the right. */
export function TenantAdmin({
  tenants,
  initial,
  onChanged,
}: {
  tenants: TenantSummary[];
  /** The tenant to open, or `null` for the form of a new one. */
  initial?: string | null;
  /** A tenant was created, changed or deleted. */
  onChanged: () => void;
}) {
  // A tenant's id, or `null` for a new one.
  const [selected, setSelected] = useState<string | null>(initial !== undefined ? initial : (tenants[0]?.id ?? null));

  return (
    <div className="flex h-full">
      <nav className="flex w-60 shrink-0 flex-col border-e border-line p-2 text-sm">
        <h2 className="section-header px-2 py-1">{t("app:nav.tenants")}</h2>
        <div className="mt-1 min-h-0 flex-1 overflow-y-auto">
          {tenants.map((t) => (
            <button key={t.id} onClick={() => setSelected(t.id)} data-active={selected === t.id} className="list-row flex w-full items-center gap-2 px-2 py-1.5 text-start">
              <TenantLogo tenant={t} size={20} />
              <span className="min-w-0 flex-1 truncate">
                {t.name} <span className="text-xs text-fg-muted">· {t.id}</span>
              </span>
            </button>
          ))}
          {!tenants.length && <p className="px-2 py-1.5 text-fg-muted">{t("noneYet")}</p>}
          <button onClick={() => setSelected(null)} data-active={selected === null} className="list-row mt-1 w-full px-2 py-1.5 text-start text-primary">
            + {t("tenants:create")}
          </button>
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
  );
}

/** The tenant's logo, or its initial when there is none or it fails to load. */
export function TenantLogo({ tenant, size = 32 }: { tenant: { name: string; logo: string | null }; size?: number }) {
  const [failed, setFailed] = useState(false);
  const style = { width: size, height: size, fontSize: size * 0.45 };
  if (tenant.logo && !failed) {
    return <img src={tenant.logo} alt="" style={style} onError={() => setFailed(true)} className="shrink-0 rounded-sm object-contain" />;
  }
  return (
    <span style={style} className="flex shrink-0 items-center justify-center rounded-sm bg-secondary-soft font-semibold text-secondary">
      {initial(tenant.name)}
    </span>
  );
}

/** Which web analytics sites (web-events) the tenant sees on its Weby dashboard, besides those of its domains. */
function WebSitesForm({ sites, busy, onSave }: { sites: string[]; busy: boolean; onSave: (sites: string[]) => void }) {
  const [text, setText] = useState(sites.join("\n"));
  const parsed = [...new Set(text.split(/[\s,]+/).map((s) => s.trim().toLowerCase()).filter(Boolean))];
  return (
    <form onSubmit={(e) => (e.preventDefault(), onSave(parsed))} className="mt-4 space-y-2">
      <h3 className="section-header">{t("tenants:webSites")}</h3>
      <p className="text-xs text-fg-muted">{t("tenants:webSitesHint")}</p>
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} className="field w-full max-w-md font-mono text-xs" />
      <button disabled={busy || parsed.join() === sites.join()} className="btn-secondary">
        {t("tenants:saveWebSites")}
      </button>
    </form>
  );
}
