import type { McpServer, McpServerStatus } from "@osiris/shared";
import { useEffect, useState, type FormEvent } from "react";
import { api } from "./api.ts";
import { PageHeader, type ScopedProps } from "./Scope.tsx";

const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** "Name: value" per line → header map. Empty text means "no change" when editing. */
function parseHeaders(text: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const i = line.indexOf(":");
    if (!line.trim()) continue;
    if (i < 1) throw new Error(`Hlavička „${line.trim()}“ musí být ve tvaru Název: hodnota`);
    headers[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return headers;
}

function Status({ status }: { status?: McpServerStatus }) {
  if (!status) return <span className="badge">nevyzkoušeno</span>;
  return status.ok ? (
    <span className="badge text-success">{status.tools.length} nástrojů</span>
  ) : (
    <span className="badge text-error" title={status.error}>
      nedostupný
    </span>
  );
}

export function McpServers({ scope, canEdit }: ScopedProps) {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [headers, setHeaders] = useState("");
  const [clearHeaders, setClearHeaders] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [editing, setEditing] = useState<McpServer>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [tested, setTested] = useState<{ name: string; status: McpServerStatus }>();

  const refresh = () => api.mcpServers().then((all) => setServers(all.filter((s) => s.scope === scope)), (e: Error) => setError(e.message));
  useEffect(() => void refresh(), []);

  const reset = () => {
    setName("");
    setUrl("");
    setHeaders("");
    setClearHeaders(false);
    setEnabled(true);
    setEditing(undefined);
  };

  const edit = (s: McpServer) => {
    setEditing(s);
    setName(s.name);
    setUrl(s.url);
    setHeaders("");
    setClearHeaders(false);
    setEnabled(s.enabled);
  };

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      // When editing, empty headers keep the stored ones unless "remove" is ticked.
      const h = editing && !headers.trim() ? (clearHeaders ? {} : undefined) : parseHeaders(headers);
      await api.saveMcpServer(name, { url, enabled, headers: h, scope });
      const saved = { name, scope };
      reset();
      if (enabled) setTested({ name: saved.name, status: await api.testMcpServer(saved.name, saved.scope) });
      await refresh();
    });
  };

  const test = (s: McpServer) =>
    run(async () => {
      setTested({ name: s.name, status: await api.testMcpServer(s.name, s.scope) });
      await refresh();
    });

  return (
    <div className="mx-auto h-full max-w-3xl overflow-y-auto p-6">
      <PageHeader title="Nástroje (MCP)" scope={scope} canEdit={canEdit}>
        Externí služby, jejichž nástroje může asistent používat (např. CRM, kalendář, účetnictví). Připojují se přes
        Model Context Protocol, jen vzdáleně přes https.
        {scope === "personal" && " Osobní servery (třeba tvůj kalendář s tvým tokenem) používá asistent jen pro tebe."}
      </PageHeader>

      {canEdit && (
      <form onSubmit={submit} className="mt-6 space-y-2">
        <div className="flex gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value.toLowerCase())}
            placeholder="název"
            pattern={NAME.source}
            readOnly={!!editing}
            required
            className="field w-48 shrink-0"
          />
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com/mcp"
            type="url"
            required
            className="field min-w-0 flex-1"
          />
        </div>
        <textarea
          value={headers}
          onChange={(e) => setHeaders(e.target.value)}
          placeholder={
            editing?.headerNames.length
              ? `Uložené hlavičky: ${editing.headerNames.join(", ")}. Nech prázdné pro zachování, nebo zadej nové.`
              : "Hlavičky, jedna na řádek (nepovinné). Klíče vkládej ze stránky Klíče a hesla:\nAuthorization: Bearer {{secret:CRM_TOKEN}}"
          }
          rows={3}
          className="field text-sm"
        />
        <div className="flex flex-wrap items-center gap-4 text-sm">
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> zapnuto
          </label>
          {!!editing?.headerNames.length && (
            <label className="flex items-center gap-1">
              <input type="checkbox" checked={clearHeaders} onChange={(e) => setClearHeaders(e.target.checked)} /> odebrat
              uložené hlavičky
            </label>
          )}
        </div>
        <div className="flex gap-2">
          <button disabled={busy} className="btn-primary">
            {busy ? "Ukládám…" : editing ? "Uložit" : "Přidat"}
          </button>
          {editing && (
            <button type="button" onClick={reset} className="btn-secondary">
              Zrušit
            </button>
          )}
        </div>
      </form>
      )}
      {error && <p className="notice notice-error mt-3 px-3 py-2 text-sm">{error}</p>}
      {tested && (
        <p className={`notice mt-3 px-3 py-2 text-sm ${tested.status.ok ? "" : "notice-error"}`}>
          {tested.name}:{" "}
          {tested.status.ok
            ? `připojeno, nástroje: ${tested.status.tools.join(", ") || "žádné"}`
            : `nepodařilo se připojit (${tested.status.error})`}
        </p>
      )}

      <ul className="mt-8 divide-y divide-line">
        {servers.map((s) => (
          <li key={`${s.scope}:${s.name}`} className="flex items-center justify-between gap-4 py-3">
            <span className="min-w-0">
              <span className="font-medium">{s.name}</span>
              <span className="ml-2 inline-flex gap-1">
                {s.enabled ? <Status status={s.status} /> : <span className="badge">vypnuto</span>}
              </span>
              <span className="block truncate text-sm text-fg-secondary">{s.url || "spravuje správce tenanta"}</span>
            </span>
            {canEdit && (
            <span className="flex shrink-0 gap-3 text-sm">
              <button onClick={() => test(s)} disabled={busy} className="btn-link">
                Vyzkoušet
              </button>
              <button onClick={() => edit(s)} className="btn-link">
                Upravit
              </button>
              <button
                onClick={() => run(async () => (await api.deleteMcpServer(s.name, s.scope), await refresh()))}
                className="btn-danger"
              >
                Smazat
              </button>
            </span>
            )}
          </li>
        ))}
        {!servers.length && <li className="py-3 text-fg-muted">Zatím žádné servery.</li>}
      </ul>
    </div>
  );
}
