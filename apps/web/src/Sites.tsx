import type { FileScope, SiteDomain, SiteRelease } from "@osiris/shared";
import { useEffect, useState } from "react";
import { api } from "./api.ts";
import { fileSize } from "./Files.tsx";
import { attempt, ErrorNotice, Field } from "./Scope.tsx";

const STATUS: Record<SiteDomain["status"], string> = { pending: "čeká na ověření", verified: "ověřená", failed: "neověřená" };

/** The tenant's website: custom domains (proved by DNS) and the releases published to them. */
export function Sites({ isAdmin }: { isAdmin: boolean }) {
  const [domains, setDomains] = useState<SiteDomain[]>();
  const [domain, setDomain] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const load = () => api.domains().then(setDomains, (e: Error) => setError(e.message));
  useEffect(() => void load(), []);
  const act = (action: () => Promise<unknown>) => attempt(setBusy, setError, async () => (await action(), await load()));

  return (
    <div className="detail max-w-4xl">
      <h1 className="text-lg font-semibold">Web</h1>
      <p className="mt-1 text-sm text-fg-secondary">
        Statický web firmy na vlastní doméně. Připrav složku s <code>index.html</code> v Souborech (nebo ať ji připraví asistent) a
        publikuj ji. Každé publikování je nové vydání, k předchozím se dá vrátit.
      </p>

      {isAdmin && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => (await api.addDomain(domain), setDomain("")));
          }}
          className="mt-4 flex gap-2"
        >
          <input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="www.mojefirma.cz" required className="field min-w-0 flex-1" />
          <button disabled={busy} className="btn-primary">
            Přidat doménu
          </button>
        </form>
      )}
      <ErrorNotice error={error} />

      <div className="mt-4 space-y-4">
        {domains?.map((d) => (
          <Domain key={d.domain} d={d} isAdmin={isAdmin} busy={busy} act={act} />
        ))}
        {domains && !domains.length && <p className="text-sm text-fg-muted">Zatím žádná doména.</p>}
      </div>
    </div>
  );
}

function Domain({ d, isAdmin, busy, act }: { d: SiteDomain; isAdmin: boolean; busy: boolean; act: (a: () => Promise<unknown>) => Promise<void> }) {
  const [releases, setReleases] = useState<SiteRelease[]>([]);
  const [source, setSource] = useState<{ scope: FileScope; dir: string }>({ scope: "tenant", dir: "web" });
  const [error, setError] = useState<string>();
  const loadReleases = () => api.releases(d.domain).then(setReleases, (e: Error) => setError(e.message));
  useEffect(() => void loadReleases(), [d.releaseId]);

  return (
    <section className="notice space-y-3 p-3 text-sm">
      <div className="flex flex-wrap items-center gap-3">
        <a href={`https://${d.domain}`} target="_blank" rel="noreferrer" className="btn-link font-medium">
          {d.domain}
        </a>
        <span className={`badge ${d.status === "verified" ? "badge-accent" : ""}`}>{STATUS[d.status]}</span>
        {isAdmin && (
          <span className="ml-auto flex gap-3">
            <button disabled={busy} onClick={() => void act(() => api.verifyDomain(d.domain))} className="btn-link">
              Ověřit
            </button>
            <button
              disabled={busy}
              onClick={() => window.confirm(`Odebrat doménu ${d.domain} i s publikovaným webem?`) && void act(() => api.removeDomain(d.domain))}
              className="btn-danger"
            >
              Odebrat
            </button>
          </span>
        )}
      </div>
      {d.error && <p className="text-xs text-error">{d.error}</p>}
      {d.status !== "verified" && (
        <div className="text-xs text-fg-secondary">
          <p>U správce DNS domény nastav:</p>
          <ul className="mt-1 list-disc pl-5">
            <li>
              TXT záznam <code>_osiris-challenge.{d.domain}</code> s hodnotou <code>{d.token}</code>
            </li>
            {d.target.cname && (
              <li>
                CNAME <code>{d.domain}</code> → <code>{d.target.cname}</code>
              </li>
            )}
            {d.target.ips.length > 0 && (
              <li>
                {d.target.cname ? "nebo " : ""}A záznam <code>{d.domain}</code> → <code>{d.target.ips.join(", ")}</code>
              </li>
            )}
          </ul>
          <p className="mt-1">Pak klikni na Ověřit. Změny DNS se mohou projevit až za několik hodin. Certifikát HTTPS se vystaví sám.</p>
        </div>
      )}

      {d.status === "verified" && isAdmin && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => (await api.publishSite({ ...source, domain: d.domain }), await loadReleases()));
          }}
          className="flex flex-wrap items-end gap-2"
        >
          <Field label="Soubory">
            <select value={source.scope} onChange={(e) => setSource({ ...source, scope: e.target.value as FileScope })} className="field w-auto">
              <option value="tenant">firemní</option>
              <option value="personal">moje</option>
            </select>
          </Field>
          <Field label="Složka">
            <input value={source.dir} onChange={(e) => setSource({ ...source, dir: e.target.value })} required className="field w-auto" />
          </Field>
          <button disabled={busy} className="btn-primary">
            Publikovat
          </button>
        </form>
      )}

      {releases.length > 0 && (
        <ul className="divide-y divide-line">
          {releases.map((r) => (
            <li key={r.id} className="flex items-center gap-3 py-1.5 text-xs">
              <span className="flex-1">
                {new Date(r.createdAt).toLocaleString("cs-CZ")} · {r.files} souborů · {fileSize(r.bytes)}
              </span>
              {r.current ? (
                <span className="badge badge-accent">aktuální</span>
              ) : (
                isAdmin && (
                  <button disabled={busy} onClick={() => void act(() => api.activateRelease(d.domain, r.id))} className="btn-link">
                    Vrátit na tuto verzi
                  </button>
                )
              )}
            </li>
          ))}
        </ul>
      )}
      <ErrorNotice error={error} />
    </section>
  );
}
