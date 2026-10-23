import { FEATURES, type MeResponse, type TenantInfo as Tenant, type TenantMember } from "@osiris/shared";
import { useEffect, useState } from "react";
import { api } from "./api.ts";
import { MasterDetail } from "./MasterDetail.tsx";
import { InviteForm } from "./Invite.tsx";
import { attempt, ErrorNotice, Loading } from "./Scope.tsx";
import { featureLabels, TenantLogo } from "./Tenants.tsx";
import { t } from "i18next";
import { Trans } from "react-i18next";

export const roleLabel = (role: Tenant["role"]) => (role === "admin" ? t("role.admin") : t("role.member"));

/** The active tenant: its overview (admins set its logo) and the features it has, each a part of its own. */
export function TenantInfo({ me, tenant, onChanged }: { me: MeResponse; tenant?: Tenant; onChanged: () => void }) {
  const [part, setPart] = useState<"overview" | "features">("overview");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  if (!tenant) return <h1 className="detail text-lg font-semibold">{t("app:noTenant")}</h1>;
  return (
    <MasterDetail
      title={tenant.name}
      groups={[{ items: [{ key: "overview", label: t("tenantInfo:overview") }, { key: "features", label: t("tenantInfo:features") }] }]}
      selected={part}
      onSelect={(k) => setPart(k as typeof part)}
    >
      {part === "overview" ? (
        <div className="detail">
          <div className="flex items-center gap-3">
            <TenantLogo tenant={tenant} size={48} />
            <h1 className="min-w-0 flex-1 text-lg font-semibold break-words">{tenant.name}</h1>
            {tenant.role === "admin" && (
              <label className={`btn-secondary cursor-pointer ${busy ? "pointer-events-none opacity-60" : ""}`}>
                {t("tenantInfo:changeLogo")}
                <input
                  type="file"
                  accept="image/png,image/jpeg"
                  hidden
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = "";
                    if (file) void attempt(setBusy, setError, async () => (await api.saveTenantLogo(file), onChanged()));
                  }}
                />
              </label>
            )}
          </div>
          <ErrorNotice error={error} />
          <dl className="notice mt-6 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 px-3 py-2 text-sm">
            <dt className="text-fg-secondary">{t("tenants:slug")}</dt>
            <dd>{tenant.id}</dd>
            <dt className="text-fg-secondary">{t("tenantInfo:myRole")}</dt>
            <dd>
              {roleLabel(tenant.role)}
              {me.systemAdmin && <span className="text-fg-muted"> · {t("role.systemAdmin")}</span>}
            </dd>
            <dt className="text-fg-secondary">{t("tenantInfo:permissions")}</dt>
            <dd>
              <code>{me.systemAdmin ? "role=osiris-admin" : `${tenant.role === "admin" ? "tenant-admin" : "tenant"}=${tenant.id}`}</code>
            </dd>
          </dl>
        </div>
      ) : (
        <div className="detail">
          <h1 className="text-lg font-semibold">{t("tenantInfo:features")}</h1>
          <ul className="mt-3 space-y-1 text-sm">
            {FEATURES.map((f) => (
              <li key={f} className={tenant.features[f] ? "" : "text-fg-muted line-through"}>
                {featureLabels()[f].label} <span className="text-fg-muted">· {featureLabels()[f].hint}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-fg-muted">{t("tenantInfo:featuresHint")}</p>
        </div>
      )}
    </MasterDetail>
  );
}

/** A tenant admin's view of the tenant's people: roles, removal, invitations and new sign-in links. */
export function Members({ self }: { self: string }) {
  const [members, setMembers] = useState<TenantMember[]>();
  const [link, setLink] = useState<{ who: string; url: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const load = () => api.members().then(setMembers, (e: Error) => setError(e.message));
  useEffect(() => void load(), []);
  const act = (action: () => Promise<unknown>) => attempt(setBusy, setError, async () => (await action(), await load()));

  return (
    <section className="relative">
      <Loading show={!members && !error} />
      <h1 className="text-lg font-semibold">{t("tenantInfo:members")}</h1>
      <ul className="mt-2 divide-y divide-line">
        {members?.map((m) => (
          <li key={m.userId} className="flex flex-wrap items-center justify-between gap-3 py-2 text-sm">
            <span className="min-w-0 truncate">
              {m.name ?? m.email ?? m.userId}
              {m.name && m.email && <span className="text-fg-muted"> · {m.email}</span>}
            </span>
            {m.userId !== self && (
              <span className="flex shrink-0 items-center gap-3">
                <select
                  value={m.role}
                  disabled={busy}
                  onChange={(e) => void act(() => api.setMemberRole(m.userId, e.target.value as TenantMember["role"]))}
                  className="field w-auto py-1"
                >
                  <option value="member">{t("role.member")}</option>
                  <option value="admin">{t("role.admin")}</option>
                </select>
                <button
                  disabled={busy}
                  onClick={() => void attempt(setBusy, setError, async () => setLink({ who: m.name ?? m.email ?? m.userId, url: (await api.loginLink(m.userId)).loginLink }))}
                  className="btn-link"
                >
                  {t("tenantInfo:loginLink")}
                </button>
                <button disabled={busy} onClick={() => window.confirm(t("tenantInfo:confirmRemove", { name: m.name ?? m.email })) && void act(() => api.removeMember(m.userId))} className="btn-danger">
                  {t("remove")}
                </button>
              </span>
            )}
          </li>
        ))}
      </ul>
      {link && <LoginLink who={link.who} url={link.url} />}
      <InviteForm
        onInvite={async (body) => {
          const result = await api.invite(body);
          await load();
          if (result.loginLink) setLink({ who: body.email, url: result.loginLink });
        }}
      />
      <ErrorNotice error={error} />
    </section>
  );
}

export function LoginLink({ who, url }: { who: string; url: string }) {
  return (
    <div className="notice mt-3 space-y-1 px-3 py-2 text-sm">
      <p>
        <Trans ns="tenantInfo" i18nKey="loginLinkFor" values={{ who }} components={{ strong: <strong /> }} />
      </p>
      <div className="flex gap-2">
        <input readOnly value={url} className="field min-w-0 flex-1 text-xs" onFocus={(e) => e.target.select()} />
        <button onClick={() => void navigator.clipboard.writeText(url)} className="btn-secondary text-sm">
          {t("copy")}
        </button>
      </div>
    </div>
  );
}
