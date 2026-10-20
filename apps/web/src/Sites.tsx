import type { SiteTarget } from "@osiris/shared";
import { useEffect, useState, type FormEvent } from "react";
import { api } from "./api.ts";
import { fileSize } from "./Files.tsx";
import { attempt, ErrorNotice, Field } from "./Scope.tsx";
import { MasterDetail } from "./MasterDetail.tsx";

const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * The tenant's website: the files in www/ published over SFTP to its hosting (a VPS at vas-hosting.cz…). Domains,
 * DNS and the web server there are managed through the hosting's MCP server (Nástroje a MCP) or its own portal.
 */
export function Sites({ isAdmin }: { isAdmin: boolean }) {
  const [targets, setTargets] = useState<SiteTarget[]>();
  const [selected, setSelected] = useState<string | null>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  const load = () => api.siteTargets().then((t) => (setTargets(t), t), (e: Error) => (setError(e.message), []));
  useEffect(() => void (isAdmin ? load().then((t) => setSelected((s) => s ?? t[0]?.name)) : undefined), []);
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
        <h1 className="text-lg font-semibold">Weby</h1>
        <p className="mt-2 text-sm text-fg-secondary">Web firmy publikuje správce tenanta ze složky www/ ve firemních souborech.</p>
      </div>
    );
  }
  const t = targets?.find((x) => x.name === selected);

  return (
    <MasterDetail
      title="Weby"
      top={
        <p className="px-2 text-xs text-fg-muted">
          Web jsou soubory ve složce <code>www</code> (s <code>index.html</code>), publikované přes SFTP na hosting. Doménu a DNS nastavíš u hostingu.
        </p>
      }
      groups={[{ title: "Cíle publikování", items: (targets ?? []).map((x) => ({ key: x.name, label: x.name, hint: `${x.username}@${x.host}${x.remoteDir}` })), empty: "Zatím žádný." }]}
      selected={selected}
      onSelect={(name) => (setNotice(undefined), setSelected(name))}
      add={{ label: "Přidat cíl publikování", onClick: () => setSelected(null) }}
    >
      {selected === null ? (
        <div className="detail max-w-3xl">
          <TargetForm key="new" onDone={(name) => void load().then(() => setSelected(name))} />
        </div>
      ) : t ? (
        <div className="detail max-w-3xl">
          <h1 className="text-lg font-semibold">{t.name}</h1>
          <p className="mt-1 text-sm text-fg-secondary">
            <code>
              {t.username}@{t.host}:{t.port}
              {t.remoteDir}
            </code>
          </p>
          <p className="mt-1 text-xs text-fg-muted">
            {t.hostKey ? `Klíč serveru: ${t.hostKey}` : "Klíč serveru se uloží při prvním připojení."}
            {t.lastPublish &&
              ` · Naposledy ${new Date(t.lastPublish.at).toLocaleString("cs-CZ")}: ${
                t.lastPublish.ok ? `nahráno ${t.lastPublish.uploaded}, smazáno ${t.lastPublish.deleted}` : `chyba (${t.lastPublish.error})`
              }`}
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
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
            <span className="flex-1" />
            <button
              disabled={busy}
              onClick={() =>
                window.confirm(`Odebrat cíl ${t.name}? Soubory na serveru zůstanou.`) &&
                void act(async () => {
                  await api.deleteSiteTarget(t.name);
                  setSelected(undefined);
                })
              }
              className="btn-danger text-sm"
            >
              Odebrat
            </button>
          </div>
          <ErrorNotice error={error} />
          {notice && <p className="notice mt-3 px-3 py-2 text-sm">{notice}</p>}
          <TargetForm key={t.name} target={t} onDone={() => void load()} />
        </div>
      ) : (
        <div className="detail">
          <ErrorNotice error={error} />
        </div>
      )}
    </MasterDetail>
  );
}

function TargetForm({ target, onDone }: { target?: SiteTarget; onDone: (name: string) => void }) {
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
      setSecret("");
      onDone(name);
    });
  };

  return (
    <form onSubmit={submit} className="mt-6 space-y-4">
      {target ? <h2 className="section-header">Nastavení</h2> : <h1 className="text-lg font-semibold">Nový cíl publikování</h1>}
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
      </div>
    </form>
  );
}
