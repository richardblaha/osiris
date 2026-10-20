import type { Integration } from "@osiris/shared";
import { useEffect, useState } from "react";
import { api, getTenant } from "./api.ts";
import { attempt, ErrorNotice } from "./Scope.tsx";

const LABELS: Record<Integration["provider"], { name: string; what: string }> = {
  google: { name: "Google", what: "Gmail, Google kontakty (v telefonu s Androidem) a Google kalendář" },
  microsoft: { name: "Microsoft", what: "Outlook / Microsoft 365: pošta, kontakty a kalendář" },
};

/** Where the browser goes back to after connecting an account: the tenant it was connected in. */
export const INTEGRATION_RETURN = "osiris.integrationReturn";

/**
 * The user's Google and Microsoft accounts the assistant may use. Connecting sends the browser to the provider, which
 * returns it to /integration-callback; the assistant then reads and sends mail, manages contacts and the calendar
 * only on the user's instructions.
 */
export function Integrations() {
  const [list, setList] = useState<Integration[]>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const load = () => api.integrations().then(setList, (e: Error) => setError(e.message));
  useEffect(() => void load(), []);

  const connect = (provider: Integration["provider"]) =>
    attempt(setBusy, setError, async () => {
      const { authorizationUrl } = await api.connectIntegration(provider);
      try {
        sessionStorage.setItem(INTEGRATION_RETURN, JSON.stringify({ tenant: getTenant() }));
      } catch {
        // The callback still works, in the last tenant.
      }
      location.assign(authorizationUrl);
    });

  if (list && !list.length) return null;
  return (
    <section className="mt-8">
      <h2 className="section-header">Propojené účty pro asistenta</h2>
      <p className="mt-1 text-xs text-fg-muted">
        Asistent pak umí číst a odesílat tvoji poštu, hledat a upravovat kontakty a plánovat v kalendáři. Odesílá a mění jen na tvůj výslovný pokyn.
      </p>
      <ErrorNotice error={error} />
      <ul className="mt-3 space-y-2 text-sm">
        {list?.map((i) => (
          <li key={i.provider} className="flex flex-wrap items-center gap-3">
            <span className="min-w-0 flex-1">
              <span className="font-medium">{LABELS[i.provider].name}</span>
              <span className="block text-xs text-fg-muted">{i.connected ? `Propojeno: ${i.account ?? "účet"}` : LABELS[i.provider].what}</span>
            </span>
            <button disabled={busy} onClick={() => void connect(i.provider)} className="btn-secondary text-sm">
              {i.connected ? "Propojit znovu" : "Propojit"}
            </button>
            {i.connected && (
              <button disabled={busy} onClick={() => void attempt(setBusy, setError, async () => (await api.disconnectIntegration(i.provider), await load()))} className="btn-danger text-sm">
                Odpojit
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
