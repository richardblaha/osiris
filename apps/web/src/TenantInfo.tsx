import { FEATURES, type MeResponse, type TenantInfo as Tenant } from "@osiris/shared";
import { FEATURE_LABELS } from "./Tenants.tsx";

export const roleLabel = (role: Tenant["role"]) => (role === "admin" ? "správce" : "uživatel");

/** The active tenant as the user's PocketID claims describe it, and the other tenants they can switch to. */
export function TenantInfo({ me, tenant, onSelect }: { me: MeResponse; tenant?: Tenant; onSelect: (id: string) => void }) {
  return (
    <div className="detail">
      {tenant ? (
        <>
          <h1 className="text-lg font-semibold">{tenant.name}</h1>
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
        </>
      ) : (
        <h1 className="text-lg font-semibold">Žádný tenant</h1>
      )}

      {me.tenants.length > 1 && (
        <>
          <h2 className="section-header mt-8">Přepnout tenanta</h2>
          <ul className="mt-2">
            {me.tenants.map((t) => (
              <li key={t.id}>
                <button onClick={() => onSelect(t.id)} data-active={t.id === tenant?.id} className="list-row block w-full px-2 py-1.5 text-left">
                  {t.name} <span className="text-xs text-fg-muted">· {t.id} · {roleLabel(t.role)}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
