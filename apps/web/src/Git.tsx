import { useEffect, useState, type FormEvent } from "react";
import { t } from "i18next";
import { Trans } from "react-i18next";
import { api, type GitStatus } from "./api.ts";
import { attempt, ErrorNotice, Field, Loading } from "./Scope.tsx";

/**
 * The project folder as a git repository (admins): connect it to a remote (its branch is checked out over the
 * project's files), see what changed, commit, pull (fast-forward only) and push. The token is the project's key
 * GIT_TOKEN, sent only to the repository's host.
 */
export function GitPanel() {
  const [status, setStatus] = useState<GitStatus>();
  const [url, setUrl] = useState("");
  const [branch, setBranch] = useState("main");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  useEffect(() => void api.gitStatus().then(setStatus, (e: Error) => setError(e.message)), []);
  const act = (action: () => Promise<GitStatus>, done?: string) =>
    attempt(setBusy, setError, async () => {
      setNotice(undefined);
      setStatus(await action());
      if (done) setNotice(done);
    });

  const connect = (e: FormEvent) => {
    e.preventDefault();
    if (window.confirm(t("projectInfo:git.confirmConnect"))) void act(() => api.gitConnect(url, branch), t("projectInfo:git.connected"));
  };
  const commit = (e: FormEvent) => {
    e.preventDefault();
    void act(async () => {
      const r = await api.gitCommit(message);
      setMessage("");
      return r.status;
    }, t("projectInfo:git.committed"));
  };

  return (
    <div className="detail relative max-w-3xl space-y-4">
      <Loading show={!status && !error} />
      <h1 className="text-lg font-semibold">{t("projectInfo:git.title")}</h1>
      <p className="text-sm text-fg-secondary">
        <Trans ns="projectInfo" i18nKey="git.intro" components={{ code: <code /> }} />
      </p>
      {status && !status.connected && (
        <form onSubmit={connect} className="space-y-3">
          <Field label={t("projectInfo:git.url")}>
            <input value={url} onChange={(e) => setUrl(e.target.value.trim())} required type="url" placeholder="https://github.com/firma/web.git" className="field" />
          </Field>
          <Field label={t("projectInfo:git.branch")}>
            <input value={branch} onChange={(e) => setBranch(e.target.value.trim())} required maxLength={100} className="field w-48" />
          </Field>
          <button disabled={busy} className="btn-primary">
            {t("projectInfo:git.connect")}
          </button>
        </form>
      )}
      {status?.connected && (
        <>
          <dl className="notice grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 px-3 py-2 text-sm">
            <dt className="text-fg-secondary">{t("projectInfo:git.url")}</dt>
            <dd className="break-all">{status.url}</dd>
            <dt className="text-fg-secondary">{t("projectInfo:git.branch")}</dt>
            <dd>{status.branch}</dd>
            <dt className="text-fg-secondary">{t("projectInfo:git.sync")}</dt>
            <dd>{t("projectInfo:git.aheadBehind", { ahead: status.ahead, behind: status.behind })}</dd>
          </dl>
          <div className="flex flex-wrap gap-2">
            <button disabled={busy} onClick={() => void act(() => api.gitPull(), t("projectInfo:git.pulled"))} className="btn-secondary text-sm">
              {t("projectInfo:git.pull")}
            </button>
            <button disabled={busy || !status.ahead} onClick={() => void act(() => api.gitPush(), t("projectInfo:git.pushed"))} className="btn-secondary text-sm">
              {t("projectInfo:git.push")}
            </button>
          </div>
          <h2 className="section-header">{t("projectInfo:git.changes", { count: status.changes.length })}</h2>
          {status.changes.length > 0 && (
            <>
              <pre className="notice max-h-60 overflow-auto px-3 py-2 text-xs">{status.changes.join("\n")}</pre>
              <form onSubmit={commit} className="flex flex-wrap gap-2">
                <input value={message} onChange={(e) => setMessage(e.target.value)} required maxLength={500} placeholder={t("projectInfo:git.message")} className="field min-w-0 flex-1" />
                <button disabled={busy} className="btn-primary text-sm">
                  {t("projectInfo:git.commit")}
                </button>
              </form>
            </>
          )}
        </>
      )}
      <ErrorNotice error={error} />
      {notice && <p className="notice px-3 py-2 text-sm">{notice}</p>}
    </div>
  );
}
