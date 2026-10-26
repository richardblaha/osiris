import type { SiteTarget } from "@osiris/shared";
import { useEffect, useState, type FormEvent } from "react";
import { api } from "./api.ts";
import { Files, fileSize } from "./Files.tsx";
import { attempt, ErrorNotice, Field } from "./Scope.tsx";
import { MasterDetail } from "./MasterDetail.tsx";
import { t } from "i18next";
import { Trans } from "react-i18next";
import { formatDateTime, formatList } from "./i18n.ts";

const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const SITE = "site";
const NEW_TARGET = "target:";
type SiteState = { exists: boolean; srcDir: string | null; builder: boolean };

/**
 * The project's website: one VitePress project in the project's root (`.vitepress/` with its settings and theme,
 * pages in `web/`), built into `.vitepress/dist/` and published over SFTP to its targets. Domains and DNS are the
 * hostings'.
 */
export function Sites({ isAdmin }: { isAdmin: boolean }) {
  const [site, setSite] = useState<SiteState>();
  const [targets, setTargets] = useState<SiteTarget[]>();
  // SITE, `target:<name>` or NEW_TARGET.
  const [selected, setSelected] = useState<string | undefined>(SITE);
  const [error, setError] = useState<string>();

  const load = () => Promise.all([api.site().then(setSite), api.siteTargets().then(setTargets)]).catch((e: Error) => setError(e.message));
  useEffect(() => void (isAdmin ? load() : undefined), []);

  if (!isAdmin) {
    return (
      <div className="detail">
        <h1 className="text-lg font-semibold">{t("app:nav.sites")}</h1>
        <p className="mt-2 text-sm text-fg-secondary">{t("sites:adminOnly")}</p>
      </div>
    );
  }
  const target = selected?.startsWith("target:") ? targets?.find((x) => `target:${x.name}` === selected) : undefined;

  return (
    <MasterDetail
      title={t("app:nav.sites")}
      loading={(!site || !targets) && !error}
      top={<p className="px-2 text-xs text-fg-muted">{t("sites:intro")}</p>}
      groups={[
        { title: t("app:nav.sites"), items: [{ key: SITE, label: t("sites:website"), hint: site?.exists ? `${site.srcDir || "/"}` : t("sites:none") }] },
        {
          title: t("sites:targets"),
          items: [
            ...(targets ?? []).map((x) => ({ key: `target:${x.name}`, label: x.name, hint: `${x.username}@${x.host}${x.remoteDir}` })),
            { key: NEW_TARGET, label: <span className="text-primary">+ {t("sites:addTarget")}</span> },
          ],
        },
      ]}
      selected={selected}
      onSelect={(key) => setSelected(key ?? undefined)}
      placeholder={t("sites:select")}
    >
      {error ? (
        <div className="detail">
          <ErrorNotice error={error} />
        </div>
      ) : selected === SITE && site ? (
        site.exists ? <SiteDetail site={site} targets={targets ?? []} onChanged={() => void load()} /> : <NewSite onCreated={() => void load()} />
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

/** A build's outcome in words. */
const describeBuild = (b: { dir: string; written: number; bytes: number; deleted: number; skipped: string[] }) =>
  [
    t("sites:built", { dir: b.dir, count: b.written, size: fileSize(b.bytes), deleted: b.deleted }),
    b.skipped.length ? t("sites:skipped", { files: `${formatList(b.skipped.slice(0, 10))}${b.skipped.length > 10 ? "…" : ""}` }) : "",
  ]
    .filter(Boolean)
    .join(" ");

const published = (target: string, r: { uploaded: number; bytes: number; deleted: number; unchanged: number }) =>
  t("sites:published", { target, uploaded: r.uploaded, size: fileSize(r.bytes), deleted: r.deleted, unchanged: r.unchanged });

function NewSite({ onCreated }: { onCreated: () => void }) {
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void attempt(setBusy, setError, async () => (await api.createSite(title), onCreated()));
  };
  return (
    <form onSubmit={submit} className="detail max-w-3xl space-y-4">
      <h1 className="text-lg font-semibold">{t("sites:new")}</h1>
      <p className="text-sm text-fg-secondary">
        <Trans ns="sites" i18nKey="newIntro" components={{ code: <code /> }} />
      </p>
      <Field label={t("sites:title")}>
        <input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={80} placeholder={t("sites:titlePlaceholder")} className="field" />
      </Field>
      <ErrorNotice error={error} />
      <button disabled={busy} className="btn-primary">
        {busy ? t("sites:creating") : t("sites:create")}
      </button>
    </form>
  );
}

function SiteDetail({ site, targets, onChanged }: { site: SiteState; targets: SiteTarget[]; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const act = (action: () => Promise<string | void>) =>
    attempt(setBusy, setError, async () => {
      setNotice(undefined);
      const message = await action();
      if (message) setNotice(message);
    });
  // Every target in turn; one failing doesn't stop the others.
  const publishAll = async () => {
    const lines: string[] = [];
    for (const x of targets) lines.push(await api.publishSite(x.name).then((r) => published(x.name, r), (e: Error) => `${x.name}: ${e.message}`));
    onChanged();
    return lines.join(" ");
  };

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-line px-6 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="min-w-0 flex-1 truncate text-lg font-semibold">{t("sites:website")}</h1>
          <button disabled={busy || !site.builder} title={site.builder ? undefined : t("sites:noBuilder")} onClick={() => void act(async () => describeBuild(await api.buildSite()))} className="btn-primary text-sm">
            {busy ? t("sites:working") : t("sites:build")}
          </button>
          {targets.length > 0 && (
            <button disabled={busy} onClick={() => void act(publishAll)} className="btn-secondary text-sm">
              {t("sites:publishAll", { count: targets.length })}
            </button>
          )}
        </div>
        <p className="mt-1 text-xs text-fg-muted">
          <Trans ns="sites" i18nKey="buildHint" values={{ dir: ".vitepress/dist" }} components={{ code: <code /> }} />
          {!targets.length && ` ${t("sites:addTargetHint")}`}
        </p>
        <ErrorNotice error={error} />
        {notice && <p className="notice mt-2 px-3 py-2 text-sm">{notice}</p>}
      </div>
      <div className="min-h-0 flex-1">
        <Files root={site.srcDir ?? ""} title={t("sites:pages")} intro={<Trans ns="sites" i18nKey="pagesIntro" components={{ code: <code /> }} />} />
      </div>
    </div>
  );
}

function TargetDetail({ target: tg, onChanged, onDeleted }: { target: SiteTarget; onChanged: () => void; onDeleted: () => void }) {
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
      <h1 className="text-lg font-semibold">{tg.name}</h1>
      <p className="mt-1 text-sm text-fg-secondary">
        <code>
          {tg.username}@{tg.host}:{tg.port}
          {tg.remoteDir}
        </code>
      </p>
      <p className="mt-1 text-xs text-fg-muted">
        {tg.hostKey ? t("sites:hostKey", { key: tg.hostKey }) : t("sites:hostKeyPending")}
        {tg.lastPublish &&
          ` · ${t("sites:lastPublish", {
            time: formatDateTime(tg.lastPublish.at),
            result: tg.lastPublish.ok ? t("sites:lastOk", { uploaded: tg.lastPublish.uploaded, deleted: tg.lastPublish.deleted }) : t("sites:lastError", { error: tg.lastPublish.error }),
          })}`}
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        <button
          disabled={busy}
          onClick={() => void act(async () => t("sites:connected", { entries: (await api.testSiteTarget(tg.name)).entries.join(", ") || t("sites:nothing") }))}
          className="btn-secondary text-sm"
        >
          {t("sites:testConnection")}
        </button>
        <button disabled={busy} onClick={() => void act(async () => (onChanged(), published(tg.name, await api.publishSite(tg.name))))} className="btn-secondary text-sm">
          {t("sites:publish")}
        </button>
        <span className="flex-1" />
        <button
          disabled={busy}
          onClick={() => window.confirm(t("sites:confirmRemoveTarget", { name: tg.name })) && void act(async () => (await api.deleteSiteTarget(tg.name), onDeleted()))}
          className="btn-danger text-sm"
        >
          {t("remove")}
        </button>
      </div>
      <ErrorNotice error={error} />
      {notice && <p className="notice mt-3 px-3 py-2 text-sm">{notice}</p>}
      <TargetForm key={tg.name} target={tg} onDone={onChanged} />
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
      {target ? <h2 className="section-header">{t("app:nav.settings")}</h2> : <h1 className="text-lg font-semibold">{t("sites:newTarget")}</h1>}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t("name")}>
          <input value={name} onChange={(e) => setName(e.target.value.toLowerCase())} pattern={NAME.source} readOnly={!!target} required placeholder={t("sites:targetNamePlaceholder")} className="field" />
        </Field>
        <Field label={t("sites:server")}>
          <input value={host} onChange={(e) => setHost(e.target.value)} required placeholder={t("sites:serverPlaceholder")} className="field" />
        </Field>
        <Field label={t("integrations:port")}>
          <input type="number" min={1} max={65535} value={port} onChange={(e) => setPort(Number(e.target.value))} className="field w-28" />
        </Field>
        <Field label={t("dashboards:columns.user")}>
          <input value={username} onChange={(e) => setUsername(e.target.value)} required className="field" />
        </Field>
      </div>
      <Field label={t("sites:remoteDir")}>
        <input value={remoteDir} onChange={(e) => setRemoteDir(e.target.value)} required pattern="/.*" placeholder={t("sites:remoteDirPlaceholder")} className="field" />
      </Field>
      <Field label={t("mcp:auth")}>
        <select value={auth} onChange={(e) => setAuth(e.target.value as SiteTarget["auth"])} className="field w-auto">
          <option value="key">{t("sites:sshKey")}</option>
          <option value="password">{t("password")}</option>
        </select>
      </Field>
      <Field label={auth === "key" ? t("sites:privateKey") : t("password")}>
        {auth === "key" ? (
          <textarea
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            rows={5}
            placeholder={target ? t("sites:keepKey") : "-----BEGIN OPENSSH PRIVATE KEY-----"}
            required={!target}
            className="field font-mono text-xs"
          />
        ) : (
          <input
            type="password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            placeholder={target ? t("sites:keepPassword") : ""}
            required={!target}
            autoComplete="new-password"
            className="field"
          />
        )}
      </Field>
      <p className="text-xs text-fg-muted">{t("sites:sealed")}</p>
      <ErrorNotice error={error} />
      <div className="flex gap-3">
        <button disabled={busy} className="btn-primary">
          {busy ? t("saving") : t("save")}
        </button>
      </div>
    </form>
  );
}
