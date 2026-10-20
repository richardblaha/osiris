import type { SiteTarget } from "@osiris/shared";
import { useEffect, useState, type FormEvent } from "react";
import { api } from "./api.ts";
import { Files, fileSize } from "./Files.tsx";
import { attempt, ErrorNotice, Field } from "./Scope.tsx";
import { MasterDetail } from "./MasterDetail.tsx";

const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SITE = /^[a-z0-9]+([.\-][a-z0-9]+)*$/;

const NEW_TARGET = "target:";

/**
 * The tenant's websites: each a VitePress template in vitepress/<site>/ (edited here like files), built into
 * www/<site>/ and published over SFTP to a target (its hosting). Domains and DNS are the hosting's.
 */
export function Sites({ isAdmin }: { isAdmin: boolean }) {
  const [sites, setSites] = useState<{ sites: string[]; builder: boolean }>();
  const [targets, setTargets] = useState<SiteTarget[]>();
  // `site:<name>`, `target:<name>`, NEW_TARGET, or null for a new site.
  const [selected, setSelected] = useState<string | null>();
  const [error, setError] = useState<string>();

  const load = () =>
    Promise.all([api.vitepressSites().then(setSites), api.siteTargets().then(setTargets)]).catch((e: Error) => setError(e.message));
  useEffect(() => void (isAdmin ? load() : undefined), []);

  if (!isAdmin) {
    return (
      <div className="detail">
        <h1 className="text-lg font-semibold">Weby</h1>
        <p className="mt-2 text-sm text-fg-secondary">Weby firmy spravuje a publikuje správce tenanta.</p>
      </div>
    );
  }
  const site = selected?.startsWith("site:") ? selected.slice(5) : undefined;
  const target = selected?.startsWith("target:") ? targets?.find((t) => `target:${t.name}` === selected) : undefined;

  return (
    <MasterDetail
      title="Weby"
      top={<p className="px-2 text-xs text-fg-muted">Web je VitePress šablona (stránky v Markdownu). Sestaví se do www/ a publikuje přes SFTP na hosting.</p>}
      groups={[
        { title: "Weby", items: (sites?.sites ?? []).map((n) => ({ key: `site:${n}`, label: n })), empty: "Zatím žádný." },
        {
          title: "Cíle publikování",
          items: [
            ...(targets ?? []).map((t) => ({ key: `target:${t.name}`, label: t.name, hint: `${t.username}@${t.host}${t.remoteDir}` })),
            { key: NEW_TARGET, label: <span className="text-primary">+ Přidat cíl publikování</span> },
          ],
        },
      ]}
      selected={selected}
      onSelect={setSelected}
      add={{ label: "Nový web", onClick: () => setSelected(null) }}
      placeholder="Vyber web nebo cíl publikování vlevo."
    >
      {error ? (
        <div className="detail">
          <ErrorNotice error={error} />
        </div>
      ) : selected === null ? (
        <NewSite onCreated={(name) => void load().then(() => setSelected(`site:${name}`))} />
      ) : site ? (
        <SiteDetail key={site} site={site} builder={!!sites?.builder} targets={targets ?? []} onDeleted={() => void load().then(() => setSelected(undefined))} />
      ) : selected === NEW_TARGET ? (
        <div className="detail max-w-3xl">
          <TargetForm key="new" onDone={(name) => void load().then(() => setSelected(`target:${name}`))} />
        </div>
      ) : target ? (
        <TargetDetail key={target.name} target={target} onChanged={() => void load()} onDeleted={() => void load().then(() => setSelected(undefined))} />
      ) : undefined}
    </MasterDetail>
  );
}

function NewSite({ onCreated }: { onCreated: (name: string) => void }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void attempt(setBusy, setError, async () => (await api.createVitepressSite(name), onCreated(name)));
  };
  return (
    <form onSubmit={submit} className="detail max-w-3xl space-y-4">
      <h1 className="text-lg font-semibold">Nový web</h1>
      <p className="text-sm text-fg-secondary">
        Vytvoří se výchozí šablona VitePressu: úvodní stránka, stránka O nás a nastavení v <code>_vitepress/config.mjs</code>. Upravit ji můžete tady,
        nebo požádat asistenta.
      </p>
      <Field label="Název (obvykle doména, např. firma.cz)">
        <input value={name} onChange={(e) => setName(e.target.value.trim().toLowerCase())} required maxLength={60} pattern={SITE.source} placeholder="firma.cz" className="field" />
      </Field>
      <ErrorNotice error={error} />
      <button disabled={busy} className="btn-primary">
        {busy ? "Vytvářím…" : "Vytvořit web"}
      </button>
    </form>
  );
}

function SiteDetail({ site, builder, targets, onDeleted }: { site: string; builder: boolean; targets: SiteTarget[]; onDeleted: () => void }) {
  const [target, setTarget] = useState(targets[0]?.name ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const act = (action: () => Promise<string | void>) =>
    attempt(setBusy, setError, async () => {
      setNotice(undefined);
      const message = await action();
      if (message) setNotice(message);
    });

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-line px-6 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="min-w-0 flex-1 truncate text-lg font-semibold">{site}</h1>
          <button disabled={busy || !builder} title={builder ? undefined : "Sestavování tu není nastavené"} onClick={() => void act(async () => (await api.buildVitepressSite(site)).message)} className="btn-primary text-sm">
            {busy ? "Pracuji…" : "Sestavit"}
          </button>
          {targets.length > 0 && (
            <>
              <select value={target} onChange={(e) => setTarget(e.target.value)} className="field w-auto text-sm" aria-label="Cíl publikování">
                {targets.map((t) => (
                  <option key={t.name} value={t.name}>
                    {t.name}
                  </option>
                ))}
              </select>
              <button
                disabled={busy || !target}
                onClick={() =>
                  void act(async () => {
                    const r = await api.publishSite(target, `www/${site}`);
                    return `Publikováno na ${target}: nahráno ${r.uploaded} (${fileSize(r.bytes)}), smazáno ${r.deleted}, beze změny ${r.unchanged}.`;
                  })
                }
                className="btn-secondary text-sm"
              >
                Publikovat
              </button>
            </>
          )}
          <button
            disabled={busy}
            onClick={() => window.confirm(`Smazat web ${site} i jeho sestavenou verzi? Na hostingu zůstane.`) && void act(async () => (await api.deleteVitepressSite(site), onDeleted()))}
            className="btn-danger text-sm"
          >
            Smazat
          </button>
        </div>
        <p className="mt-1 text-xs text-fg-muted">
          Sestavení uloží hotový web do <code>www/{site}</code>; publikování ho nahraje na vybraný cíl.{!targets.length && " Cíl publikování přidáte vlevo."}
        </p>
        <ErrorNotice error={error} />
        {notice && <p className="notice mt-2 px-3 py-2 text-sm">{notice}</p>}
      </div>
      <div className="min-h-0 flex-1">
        <Files
          root={`vitepress/${site}`}
          title="Šablona"
          intro={
            <>
              Stránky jsou soubory <code>.md</code> (<code>index.md</code> je úvodní), obrázky patří do <code>public/</code>, nastavení a téma do{" "}
              <code>_vitepress/</code>.
            </>
          }
        />
      </div>
    </div>
  );
}

function TargetDetail({ target: t, onChanged, onDeleted }: { target: SiteTarget; onChanged: () => void; onDeleted: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const act = (action: () => Promise<string | void>) =>
    attempt(setBusy, setError, async () => {
      setNotice(undefined);
      const message = await action();
      if (message) setNotice(message);
    });
  return (
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
          onClick={() => void act(async () => `Připojeno. Ve složce: ${(await api.testSiteTarget(t.name)).entries.join(", ") || "nic"}.`)}
          className="btn-secondary text-sm"
        >
          Vyzkoušet připojení
        </button>
        <span className="flex-1" />
        <button
          disabled={busy}
          onClick={() => window.confirm(`Odebrat cíl ${t.name}? Soubory na serveru zůstanou.`) && void act(async () => (await api.deleteSiteTarget(t.name), onDeleted()))}
          className="btn-danger text-sm"
        >
          Odebrat
        </button>
      </div>
      <ErrorNotice error={error} />
      {notice && <p className="notice mt-3 px-3 py-2 text-sm">{notice}</p>}
      <TargetForm key={t.name} target={t} onDone={onChanged} />
    </div>
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
