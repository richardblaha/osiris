import { FEATURES, type MeResponse, type TenantInfo as Tenant, type TenantMember } from "@osiris/shared";
import { useEffect, useState } from "react";
import { api } from "./api.ts";
import { InviteForm } from "./Invite.tsx";
import { attempt, ErrorNotice } from "./Scope.tsx";
import { FEATURE_LABELS, TenantLogo } from "./Tenants.tsx";

export const roleLabel = (role: Tenant["role"]) => (role === "admin" ? "správce" : "uživatel");

/** The active tenant as the user's claims describe it (switching is in the sidebar's tenant menu); admins set its logo. */
export function TenantInfo({ me, tenant, onChanged }: { me: MeResponse; tenant?: Tenant; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  return (
    <div className="detail">
      {tenant ? (
        <>
          <div className="flex items-center gap-3">
            <TenantLogo tenant={tenant} size={48} />
            <h1 className="min-w-0 flex-1 text-lg font-semibold break-words">{tenant.name}</h1>
            {tenant.role === "admin" && (
              <label className={`btn-secondary cursor-pointer ${busy ? "pointer-events-none opacity-60" : ""}`}>
                Změnit logo
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
            <dt className="text-fg-secondary">Zkratka</dt>
            <dd>{tenant.id}</dd>
            <dt className="text-fg-secondary">Moje role</dt>
            <dd>
              {roleLabel(tenant.role)}
              {me.systemAdmin && <span className="text-fg-muted"> · správce systému</span>}
            </dd>
            <dt className="text-fg-secondary">Oprávnění</dt>
            <dd>
              <code>{me.systemAdmin ? "role=osiris-admin" : `${tenant.role === "admin" ? "tenant-admin" : "tenant"}=${tenant.id}`}</code>
            </dd>
          </dl>

          <h2 className="section-header mt-8">Funkce</h2>
          <ul className="mt-2 space-y-1 text-sm">
            {FEATURES.map((f) => (
              <li key={f} className={tenant.features[f] ? "" : "text-fg-muted line-through"}>
                {FEATURE_LABELS[f].label} <span className="text-fg-muted">· {FEATURE_LABELS[f].hint}</span>
              </li>
            ))}
          </ul>
          <p className="mt-1 text-xs text-fg-muted">Funkce zapíná a vypíná správce systému.</p>
          {tenant.role === "admin" && <Members key={tenant.id} self={me.user.id} />}
        </>
      ) : (
        <h1 className="text-lg font-semibold">Žádný tenant</h1>
      )}
    </div>
  );
}

/** A tenant admin's view of the tenant's people: roles, removal, invitations and new sign-in links. */
function Members({ self }: { self: string }) {
  const [members, setMembers] = useState<TenantMember[]>();
  const [link, setLink] = useState<{ who: string; url: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const load = () => api.members().then(setMembers, (e: Error) => setError(e.message));
  useEffect(() => void load(), []);
  const act = (action: () => Promise<unknown>) => attempt(setBusy, setError, async () => (await action(), await load()));

  return (
    <section className="mt-8">
      <h2 className="section-header">Lidé v tenantovi</h2>
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
                  <option value="member">uživatel</option>
                  <option value="admin">správce</option>
                </select>
                <button
                  disabled={busy}
                  onClick={() => void attempt(setBusy, setError, async () => setLink({ who: m.name ?? m.email ?? m.userId, url: (await api.loginLink(m.userId)).loginLink }))}
                  className="btn-link"
                >
                  Přihlašovací odkaz
                </button>
                <button disabled={busy} onClick={() => window.confirm(`Odebrat ${m.name ?? m.email} z tenanta?`) && void act(() => api.removeMember(m.userId))} className="btn-danger">
                  Odebrat
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
        Jednorázový přihlašovací odkaz pro <strong>{who}</strong> (platí 3 dny). Pošli ho dotyčnému, po přihlášení si nastaví klíč (passkey), heslo nebo propojí účet Google či Microsoft.
      </p>
      <div className="flex gap-2">
        <input readOnly value={url} className="field min-w-0 flex-1 text-xs" onFocus={(e) => e.target.select()} />
        <button onClick={() => void navigator.clipboard.writeText(url)} className="btn-secondary text-sm">
          Kopírovat
        </button>
      </div>
    </div>
  );
}
