import type { SiteTarget } from "@osiris/shared";
import { useEffect, useState, type FormEvent } from "react";
import { api } from "./api.ts";
import { fileSize } from "./Files.tsx";
import { attempt, ErrorNotice, Field } from "./Scope.tsx";

const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * The tenant's website: the files in www/ published over SFTP to its hosting (a VPS at vas-hosting.cz…). Domains,
 * DNS and the web server there are managed through the hosting's MCP server (Nástroje a MCP) or its own portal.
 */
export function Sites({ isAdmin }: { isAdmin: boolean }) {
  const [targets, setTargets] = useState<SiteTarget[]>();
  const [editing, setEditing] = useState<SiteTarget | "new">();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  const load = () => api.siteTargets().then(setTargets, (e: Error) => setError(e.message));
  useEffect(() => void (isAdmin ? load() : undefined), []);
  const act = (action: () => Promise<string | void>) =>
    attempt(setBusy, setError, async () => {
      setNotice(undefined);
      const message = await action();
      if (message) setNotice(message);
      await load();
    });

  if (!isAdmin) {
    return (
      <div className="detail">
        <h1 className="text-lg font-semibold">Web</h1>
        <p className="mt-2 text-sm text-fg-secondary">Web firmy publikuje správce tenanta ze složky www/ ve firemních souborech.</p>
      </div>
    );
  }

  return (
    <div className="detail max-w-3xl">
      <h1 className="text-lg font-semibold">Web</h1>
      <p className="mt-1 text-sm text-fg-secondary">
        Web firmy jsou soubory ve složce <code>www</code> (firemní soubory, musí obsahovat <code>index.html</code>). Publikování je nahraje přes SFTP
        na hosting, např. na VPS u vas-hosting.cz; nahrávají se jen změny a mažou jen soubory, které tam dřív nahrál Osiris. Doménu a DNS
        nastavíš v portálu hostingu nebo přes asistenta s MCP serverem vas-hosting.
      </p>
      <ErrorNotice error={error} />
      {notice && <p className="notice mt-3 px-3 py-2 text-sm">{notice}</p>}

      <ul className="mt-4 space-y-3">
        {targets?.map((t) => (
          <li key={t.name} className="notice px-3 py-2 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{t.name}</span>
              <code className="text-xs text-fg-secondary">
                {t.username}@{t.host}:{t.port}
                {t.remoteDir}
              </code>
              <span className="flex-1" />
              <button
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    const r = await api.publishSite(t.name);
                    return `Publikováno: nahráno ${r.uploaded} (${fileSize(r.bytes)}), smazáno ${r.deleted}, beze změny ${r.unchanged}.`;
                  })
                }
                className="btn-primary text-sm"
              >
                {busy ? "Pracuji…" : "Publikovat www/"}
              </button>
              <button
                disabled={busy}
                onClick={() => void act(async () => `Připojeno. Ve složce: ${(await api.testSiteTarget(t.name)).entries.join(", ") || "nic"}.`)}
                className="btn-secondary text-sm"
              >
                Vyzkoušet
              </button>
              <button disabled={busy} onClick={() => setEditing(t)} className="btn-link text-sm">
                Upravit
              </button>
              <button
                disabled={busy}
                onClick={() => window.confirm(`Odebrat cíl ${t.name}? Soubory na serveru zůstanou.`) && void act(async () => void (await api.deleteSiteTarget(t.name)))}
                className="btn-danger text-sm"
              >
                Odebrat
              </button>
            </div>
            <p className="mt-1 text-xs text-fg-muted">
              {t.hostKey ? `Klíč serveru: ${t.hostKey}` : "Klíč serveru se uloží při prvním připojení."}
              {t.lastPublish &&
                ` · Naposledy ${new Date(t.lastPublish.at).toLocaleString("cs-CZ")}: ${
                  t.lastPublish.ok ? `nahráno ${t.lastPublish.uploaded}, smazáno ${t.lastPublish.deleted}` : `chyba (${t.lastPublish.error})`
                }`}
            </p>
          </li>
        ))}
      </ul>
      {targets && !targets.length && !editing && <p className="mt-4 text-sm text-fg-muted">Zatím žádný cíl publikování.</p>}

      {editing ? (
        <TargetForm
          key={editing === "new" ? "new" : editing.name}
          target={editing === "new" ? undefined : editing}
          onDone={() => {
            setEditing(undefined);
            void load();
          }}
        />
      ) : (
        <button onClick={() => setEditing("new")} className="btn-secondary mt-4 text-sm">
          + Přidat cíl publikování
        </button>
      )}
    </div>
  );
}

function TargetForm({ target, onDone }: { target?: SiteTarget; onDone: () => void }) {
  const [name, setName] = useState(target?.name ?? "");
  const [host, setHost] = useState(target?.host ?? "");
  const [port, setPort] = useState(target?.port ?? 22);
  const [username, setUsername] = useState(target?.username ?? "");
  const [remoteDir, setRemoteDir] = useState(target?.remoteDir ?? "/var/www/");
  const [auth, setAuth] = useState<SiteTarget["auth"]>(target?.auth ?? "key");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void attempt(setBusy, setError, async () => {
      await api.saveSiteTarget(name, { host, port, username, remoteDir, auth, secret: secret || undefined });
      onDone();
    });
  };

  return (
    <form onSubmit={submit} className="mt-6 space-y-4">
      <h2 className="section-header">{target ? `Upravit ${target.name}` : "Nový cíl publikování"}</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Název">
          <input value={name} onChange={(e) => setName(e.target.value.toLowerCase())} pattern={NAME.source} readOnly={!!target} required placeholder="např. firma-cz" className="field" />
        </Field>
        <Field label="Server (SFTP)">
          <input value={host} onChange={(e) => setHost(e.target.value)} required placeholder="např. 185.8.236.10" className="field" />
        </Field>
        <Field label="Port">
          <input type="number" min={1} max={65535} value={port} onChange={(e) => setPort(Number(e.target.value))} className="field w-28" />
        </Field>
        <Field label="Uživatel">
          <input value={username} onChange={(e) => setUsername(e.target.value)} required className="field" />
        </Field>
      </div>
      <Field label="Cílová složka na serveru">
        <input value={remoteDir} onChange={(e) => setRemoteDir(e.target.value)} required pattern="/.*" placeholder="/var/www/firma.cz" className="field" />
      </Field>
      <Field label="Přihlášení">
        <select value={auth} onChange={(e) => setAuth(e.target.value as SiteTarget["auth"])} className="field w-auto">
          <option value="key">SSH klíč</option>
          <option value="password">heslo</option>
        </select>
      </Field>
      <Field label={auth === "key" ? "Privátní klíč (OpenSSH/PEM)" : "Heslo"}>
        {auth === "key" ? (
          <textarea
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            rows={5}
            placeholder={target ? "Uložený klíč zůstane, pokud nevložíš nový." : "-----BEGIN OPENSSH PRIVATE KEY-----"}
            required={!target}
            className="field font-mono text-xs"
          />
        ) : (
          <input
            type="password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            placeholder={target ? "Uložené heslo zůstane, pokud nezadáš nové." : ""}
            required={!target}
            autoComplete="new-password"
            className="field"
          />
        )}
      </Field>
      <p className="text-xs text-fg-muted">Heslo i klíč se ukládají šifrovaně a už se nikde nezobrazí.</p>
      <ErrorNotice error={error} />
      <div className="flex gap-3">
        <button disabled={busy} className="btn-primary">
          {busy ? "Ukládám…" : "Uložit"}
        </button>
        <button type="button" onClick={onDone} className="btn-secondary">
          Zrušit
        </button>
      </div>
    </form>
  );
}
