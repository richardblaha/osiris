import type { McpServer, McpServerStatus, Scope } from "@osiris/shared";
import { useState, type FormEvent } from "react";
import { api, getTenant } from "./api.ts";
import { attempt, canEdit, DetailHeader, ErrorNotice, Field, OwnCopy, ScopeChoice, type DetailProps } from "./Scope.tsx";
import { t } from "i18next";

const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export const mcpKey = (s: Pick<McpServer, "scope" | "name">) => `${s.scope}:${s.name}`;

/** "Name: value" per line → header map. Empty text means "no change" when editing. */
function parseHeaders(text: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const i = line.indexOf(":");
    if (!line.trim()) continue;
    if (i < 1) throw new Error(t("mcp:headerFormat", { line: line.trim() }));
    headers[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return headers;
}

export function McpStatus({ server }: { server: McpServer }) {
  const status = server.status;
  if (!server.enabled) return <span className="badge">{t("mcp:off")}</span>;
  if (!status) return <span className="badge">{t("mcp:untested")}</span>;
  return status.ok ? (
    <span className="badge text-success">{t("mcp:toolCount", { count: status.tools.length })}</span>
  ) : (
    <span className="badge text-error" title={status.error}>
      {t("mcp:unavailable")}
    </span>
  );
}

/** Services Osiris knows: filled in with one click. Each tenant (or user) connects its own account. */
const PRESETS: { label: string; name: string; url: string; auth: McpServer["auth"]; headers?: string; hint: () => string }[] = [
  {
    label: "vas-hosting.cz",
    name: "vas-hosting",
    url: "https://portal.vas-hosting.cz/mcp",
    auth: "oauth",
    hint: () => t("mcp:presets.vasHosting"),
  },
  {
    label: "Emailit",
    name: "emailit",
    url: "https://api.emailit.com/mcp",
    auth: "headers",
    headers: "Authorization: Bearer {{secret:EMAILIT_API_KEY}}",
    hint: () => t("mcp:presets.emailit"),
  },
];

/** Where the browser goes back to after an OAuth sign-in: the server and tenant it was for. */
export const MCP_SIGN_IN = "osiris.mcpSignIn";

/**
 * A server of the tenant's or the viewer's own. A member can't see or change the tenant's, but can add their own of the
 * same name, which replaces it in their runs (`copying`: the form for it, the tenant's server left alone).
 */
export function McpServerDetail({ item: shown, scope: tab, isAdmin, onSaved, onDeleted }: DetailProps<McpServer>) {
  const [copying, setCopying] = useState(false);
  // The record being edited: none while writing the viewer's own copy.
  const item = copying ? undefined : shown;
  const [target, setTarget] = useState<Scope>(tab);
  const [name, setName] = useState(shown?.name ?? "");
  const [url, setUrl] = useState(item?.url ?? "");
  const [auth, setAuth] = useState<McpServer["auth"]>(item?.auth ?? "headers");
  const [hint, setHint] = useState<string>();
  const [headers, setHeaders] = useState("");
  const [clearHeaders, setClearHeaders] = useState(false);
  const [enabled, setEnabled] = useState(item?.enabled ?? true);
  const scope = copying ? "personal" : (item?.scope ?? target);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [tested, setTested] = useState<McpServerStatus>();
  const editable = !item || canEdit(item.scope, isAdmin);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void attempt(setBusy, setError, async () => {
      // When editing, empty headers keep the stored ones unless "remove" is ticked.
      const h = item && !headers.trim() ? (clearHeaders ? {} : undefined) : parseHeaders(headers);
      await api.saveMcpServer(name, { url, enabled, auth, headers: auth === "oauth" ? {} : h, scope });
      // An OAuth server needs the owner to sign in at the provider first.
      if (auth === "oauth" && !item?.signedIn) return signIn(name);
      // The connection test result is stored with the server, so the list shows it after the reload.
      if (enabled) await api.testMcpServer(name, scope).catch(() => {});
      onSaved(mcpKey({ scope, name }));
    });
  };

  const test = () => attempt(setBusy, setError, async () => setTested(await api.testMcpServer(item!.name, item!.scope)));

  /** Off to the provider's sign-in; it sends the browser back to /mcp-callback, which finishes it. */
  const signIn = async (server: string) => {
    const { authorizationUrl } = await api.signInMcpServer(server, scope);
    if (!authorizationUrl) return setTested(await api.testMcpServer(server, scope));
    try {
      sessionStorage.setItem(MCP_SIGN_IN, JSON.stringify({ tenant: getTenant(), name: server, scope }));
    } catch {
      // The callback still works; it just can't return to this server's page.
    }
    location.assign(authorizationUrl);
  };

  const preset = (p: (typeof PRESETS)[number]) => {
    setName(p.name);
    setUrl(p.url);
    setAuth(p.auth);
    setHeaders(p.headers ?? "");
    setHint(p.hint());
  };
  const status = tested ?? item?.status;

  return (
    <div className="detail">
      <DetailHeader title={shown?.name ?? t("mcp:new")} scope={scope} canEdit={editable} overridden={item?.overridden}>
        {t("mcp:intro")}
      </DetailHeader>

      {item && (
        <p className={`notice mt-6 px-3 py-2 text-sm ${(status && !status.ok) || (item.auth === "oauth" && !item.signedIn) ? "notice-error" : ""}`}>
          {!item.enabled
            ? t("mcp:status.off")
            : item.auth === "oauth" && !item.signedIn
              ? t("mcp:status.signedOut")
              : !status
                ? t("mcp:status.untested")
                : status.ok
                  ? t("mcp:status.connected", { tools: status.tools.join(", ") || t("mcp:status.noTools") })
                  : t("mcp:status.failed", { error: status.error })}
        </p>
      )}

      {!item && editable && (
        <div className="mt-6 flex flex-wrap items-center gap-2 text-sm">
          <span className="text-fg-secondary">{t("mcp:presets.label")}</span>
          {PRESETS.map((p) => (
            <button key={p.name} type="button" onClick={() => preset(p)} className="btn-secondary text-sm">
              {p.label}
            </button>
          ))}
        </div>
      )}
      {hint && <p className="mt-2 text-xs text-fg-muted">{hint}</p>}

      {editable ? (
        <form onSubmit={submit} className="mt-6 space-y-4">
          {!shown && <ScopeChoice value={target} onChange={setTarget} isAdmin={isAdmin} />}
          <Field label={t("name")}>
            <input
              value={name}
              onChange={(e) => setName(e.target.value.toLowerCase())}
              placeholder={t("mcp:namePlaceholder")}
              pattern={NAME.source}
              readOnly={!!shown}
              required
              className="field"
            />
          </Field>
          <Field label={t("mcp:url")}>
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/mcp" type="url" required className="field" />
          </Field>
          <Field label={t("mcp:auth")}>
            <select value={auth} onChange={(e) => setAuth(e.target.value as McpServer["auth"])} className="field w-auto">
              <option value="headers">{t("mcp:authHeaders")}</option>
              <option value="oauth">{t("mcp:authOauth")}</option>
            </select>
          </Field>
          {auth === "headers" && (
          <Field label={t("mcp:headers")}>
            <textarea
              value={headers}
              onChange={(e) => setHeaders(e.target.value)}
              placeholder={
                item?.headerNames.length
                  ? t("mcp:headersStored", { names: item.headerNames.join(", ") })
                  : `${t("mcp:headersHint")}\nAuthorization: Bearer {{secret:CRM_TOKEN}}`
              }
              rows={3}
              className="field text-sm"
            />
          </Field>
          )}
          <div className="flex flex-wrap items-center gap-4 text-sm">
            <label className="flex items-center gap-1">
              <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> {t("mcp:enabled")}
            </label>
            {!!item?.headerNames.length && (
              <label className="flex items-center gap-1">
                <input type="checkbox" checked={clearHeaders} onChange={(e) => setClearHeaders(e.target.checked)} /> {t("mcp:clearHeaders")}
              </label>
            )}
          </div>
          <div className="flex items-center gap-4">
            <button disabled={busy} className="btn-primary">
              {busy ? t("saving") : item ? t("save") : auth === "oauth" ? t("mcp:addSignIn") : t("add")}
            </button>
            {item && (
              <>
                {item.auth === "oauth" && (
                  <button type="button" onClick={() => void attempt(setBusy, setError, () => signIn(item.name))} disabled={busy} className="btn-secondary">
                    {item.signedIn ? t("mcp:signInAgain") : t("mcp:signIn")}
                  </button>
                )}
                <button type="button" onClick={test} disabled={busy || !item.enabled} className="btn-secondary">
                  {t("mcp:test")}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => attempt(setBusy, setError, async () => (await api.deleteMcpServer(item.name, item.scope), onDeleted()))}
                  className="btn-danger text-sm"
                >
                  {t("delete")}
                </button>
              </>
            )}
          </div>
        </form>
      ) : (
        <>
          <p className="mt-4 text-sm text-fg-secondary">{t("mcp:adminOnly")}</p>
          {!shown?.overridden && <OwnCopy onClick={() => (setUrl(""), setHeaders(""), setCopying(true))} />}
        </>
      )}
      <ErrorNotice error={error} />
    </div>
  );
}
