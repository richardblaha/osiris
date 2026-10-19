import type { McpServer, McpServerStatus, Scope } from "@osiris/shared";
import { useState, type FormEvent } from "react";
import { api } from "./api.ts";
import { attempt, canEdit, DetailHeader, ErrorNotice, Field, type DetailProps } from "./Scope.tsx";

const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export const mcpKey = (s: Pick<McpServer, "scope" | "name">) => `${s.scope}:${s.name}`;

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

export function McpStatus({ server }: { server: McpServer }) {
  const status = server.status;
  if (!server.enabled) return <span className="badge">vypnuto</span>;
  if (!status) return <span className="badge">nevyzkoušeno</span>;
  return status.ok ? (
    <span className="badge text-success">{status.tools.length} nástrojů</span>
  ) : (
    <span className="badge text-error" title={status.error}>
      nedostupný
    </span>
  );
}

export function McpServerDetail({ item, scope: tab, isAdmin, onSaved, onDeleted }: DetailProps<McpServer>) {
  const [name, setName] = useState(item?.name ?? "");
  const [url, setUrl] = useState(item?.url ?? "");
  const [headers, setHeaders] = useState("");
  const [clearHeaders, setClearHeaders] = useState(false);
  const [enabled, setEnabled] = useState(item?.enabled ?? true);
  const scope = item?.scope ?? tab;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [tested, setTested] = useState<McpServerStatus>();
  const editable = !item || canEdit(item.scope, isAdmin);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void attempt(setBusy, setError, async () => {
      // When editing, empty headers keep the stored ones unless "remove" is ticked.
      const h = item && !headers.trim() ? (clearHeaders ? {} : undefined) : parseHeaders(headers);
      await api.saveMcpServer(name, { url, enabled, headers: h, scope });
      // The connection test result is stored with the server, so the list shows it after the reload.
      if (enabled) await api.testMcpServer(name, scope).catch(() => {});
      onSaved(mcpKey({ scope, name }));
    });
  };

  const test = () => attempt(setBusy, setError, async () => setTested(await api.testMcpServer(item!.name, item!.scope)));
  const status = tested ?? item?.status;

  return (
    <div className="detail">
      <DetailHeader title={item?.name ?? "Nový MCP server"} scope={scope} canEdit={editable}>
        Externí služba, jejíž nástroje může asistent používat (např. CRM, kalendář, účetnictví). Připojuje se přes Model
        Context Protocol, jen vzdáleně přes https.
      </DetailHeader>

      {item && (
        <p className={`notice mt-6 px-3 py-2 text-sm ${status && !status.ok ? "notice-error" : ""}`}>
          {!item.enabled
            ? "Server je vypnutý."
            : !status
              ? "Zatím nevyzkoušeno."
              : status.ok
                ? `Připojeno, nástroje: ${status.tools.join(", ") || "žádné"}`
                : `Nepodařilo se připojit (${status.error})`}
        </p>
      )}

      {editable ? (
        <form onSubmit={submit} className="mt-6 space-y-4">
          <Field label="Název">
            <input
              value={name}
              onChange={(e) => setName(e.target.value.toLowerCase())}
              placeholder="např. crm"
              pattern={NAME.source}
              readOnly={!!item}
              required
              className="field"
            />
          </Field>
          <Field label="Adresa">
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/mcp" type="url" required className="field" />
          </Field>
          <Field label="Hlavičky">
            <textarea
              value={headers}
              onChange={(e) => setHeaders(e.target.value)}
              placeholder={
                item?.headerNames.length
                  ? `Uložené hlavičky: ${item.headerNames.join(", ")}. Nech prázdné pro zachování, nebo zadej nové.`
                  : "Jedna na řádek (nepovinné). Klíče vkládej ze sekce Klíče a hesla:\nAuthorization: Bearer {{secret:CRM_TOKEN}}"
              }
              rows={3}
              className="field text-sm"
            />
          </Field>
          <div className="flex flex-wrap items-center gap-4 text-sm">
            <label className="flex items-center gap-1">
              <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> zapnuto
            </label>
            {!!item?.headerNames.length && (
              <label className="flex items-center gap-1">
                <input type="checkbox" checked={clearHeaders} onChange={(e) => setClearHeaders(e.target.checked)} /> odebrat uložené hlavičky
              </label>
            )}
          </div>
          <div className="flex items-center gap-4">
            <button disabled={busy} className="btn-primary">
              {busy ? "Ukládám…" : item ? "Uložit" : "Přidat"}
            </button>
            {item && (
              <>
                <button type="button" onClick={test} disabled={busy || !item.enabled} className="btn-secondary">
                  Vyzkoušet
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => attempt(setBusy, setError, async () => (await api.deleteMcpServer(item.name, item.scope), onDeleted()))}
                  className="btn-danger text-sm"
                >
                  Smazat
                </button>
              </>
            )}
          </div>
        </form>
      ) : (
        <p className="mt-4 text-sm text-fg-secondary">Adresu a hlavičky vidí jen správce tenanta.</p>
      )}
      <ErrorNotice error={error} />
    </div>
  );
}
