import { FEATURES, type DirectoryUser, type Feature, type Role, type ProjectDetail, type ProjectSummary } from "@osiris/shared";
import { useEffect, useState, type FormEvent } from "react";
import { Icon } from "./Icon.tsx";
import { api } from "./api.ts";
import { InviteForm } from "./Invite.tsx";
import { attempt, ErrorNotice, Field, Pending } from "./Scope.tsx";
import { LoginLink } from "./ProjectInfo.tsx";
import { fileSize } from "./Files.tsx";
import { QuotaForm } from "./Quotas.tsx";
import { t } from "i18next";
import { Trans } from "react-i18next";
import { formatDateTime, initial } from "./i18n.ts";

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Each feature's name and what it does, in the current language. */
export const featureLabels = (): Record<Feature, { label: string; hint: string }> =>
  Object.fromEntries(FEATURES.map((f) => [f, { label: t(`projects:features.${f}.label`), hint: t(`projects:features.${f}.hint`) }])) as Record<Feature, { label: string; hint: string }>;

/** System admins (claim role=osiris-admin) create projects here; each project's detail is a `ProjectPanel`. */
export function NewProject({ onCreated }: { onCreated: (id: string) => void }) {
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const create = (e: FormEvent) => {
    e.preventDefault();
    void attempt(setBusy, setError, async () => {
      await api.admin.createProject(id, name);
      onCreated(id);
    });
  };

  return (
    <div className="detail">
      <h1 className="text-lg font-semibold">{t("projects:new")}</h1>
      <p className="mt-1 text-sm text-fg-secondary">
        <Trans ns="projects" i18nKey="newIntro" values={{ slug: t("projects:slugToken") }} components={{ code: <code /> }} />
      </p>
      <form onSubmit={create} className="mt-6 space-y-4">
        <Field label={t("projects:slug")}>
          <input
            value={id}
            onChange={(e) => setId(e.target.value.toLowerCase())}
            placeholder={t("projects:slugPlaceholder")}
            pattern={SLUG.source}
            title={t("projects:slugHint")}
            maxLength={40}
            required
            className="field"
          />
        </Field>
        <Field label={t("name")}>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("projects:namePlaceholder")} required className="field" />
        </Field>
        <button disabled={busy} className="btn-primary">
          {busy ? t("projects:creating") : t("projects:create")}
        </button>
      </form>
      <ErrorNotice error={error} />
    </div>
  );
}

export function ProjectPanel({ id, onChanged, onDeleted }: { id: string; onChanged: () => void; onDeleted: () => void }) {
  const [project, setProject] = useState<ProjectDetail>();
  const [users, setUsers] = useState<DirectoryUser[]>([]);
  const [name, setName] = useState("");
  const [newUser, setNewUser] = useState("");
  const [newRole, setNewRole] = useState<Role>("member");
  const [confirm, setConfirm] = useState("");
  const [ops, setOps] = useState({ idleMinutes: 30, storageGb: 5 });
  const [link, setLink] = useState<{ who: string; url: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const load = () =>
    api.admin.project(id).then((t) => {
      setProject(t);
      setName(t.name);
      setOps({ idleMinutes: t.idleMinutes, storageGb: t.storageGb });
    });

  useEffect(() => {
    load().catch((e: Error) => setError(e.message));
    api.admin.users().then(setUsers, (e: Error) => setError(e.message));
  }, []);

  /** Runs a change, reloads the project and tells the parent (names, members and features show elsewhere too). */
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
      await load();
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!project) return <Pending error={error} className="relative h-full" />;
  const memberIds = new Set(project.memberList.map((m) => m.userId));
  const candidates = users.filter((u) => !memberIds.has(u.id));
  const labels = featureLabels();

  return (
    <div className="detail space-y-8">
      <h1 className="text-lg font-semibold">{project.name}</h1>
      <section>
        <h2 className="section-header">{t("name")}</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => api.admin.updateProject(id, { name }));
          }}
          className="mt-2 flex gap-2"
        >
          <input value={name} onChange={(e) => setName(e.target.value)} required className="field min-w-0 flex-1" />
          <button disabled={busy || name === project.name} className="btn-secondary">
            {t("projects:rename")}
          </button>
        </form>
        <p className="mt-1 text-xs text-fg-muted">{t("projects:slugValue", { id: project.id })}</p>
      </section>

      <section>
        <h2 className="section-header">{t("projects:features.title")}</h2>
        <div className="mt-2 space-y-1.5">
          {FEATURES.map((f) => (
            <label key={f} className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={project.features[f]}
                disabled={busy}
                onChange={(e) => void run(() => api.admin.updateProject(id, { features: { [f]: e.target.checked } }))}
                className="mt-0.5"
              />
              <span>
                {labels[f].label} <span className="text-fg-muted">· {labels[f].hint}</span>
              </span>
            </label>
          ))}
        </div>
      </section>

      <section>
        <h2 className="section-header">{t("projects:operation")}</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => api.admin.updateProject(id, ops));
          }}
          className="mt-2 flex flex-wrap items-end gap-3"
        >
          <Field label={t("projects:idle")}>
            <input type="number" min={0} max={1440} value={ops.idleMinutes} onChange={(e) => setOps({ ...ops, idleMinutes: Number(e.target.value) })} className="field w-28" />
          </Field>
          <Field label={t("projects:disk")}>
            <input type="number" min={project.storageGb} max={500} value={ops.storageGb} onChange={(e) => setOps({ ...ops, storageGb: Number(e.target.value) })} className="field w-28" />
          </Field>
          <button disabled={busy || (ops.idleMinutes === project.idleMinutes && ops.storageGb === project.storageGb)} className="btn-secondary">
            {t("save")}
          </button>
        </form>
        <h3 className="section-header mt-4">{t("projects:quotas")}</h3>
        <p className="mt-1 text-xs text-fg-muted">{t("projects:quotasHint")}</p>
        <QuotaForm key={JSON.stringify(project.quotas)} quotas={project.quotas} busy={busy} onSave={(quotas) => void run(() => api.admin.updateProject(id, { quotas }))} />
        <WebSitesForm key={project.webSites.join()} sites={project.webSites} busy={busy} onSave={(webSites) => void run(() => api.admin.updateProject(id, { webSites }))} />
        <div className="mt-4 flex items-center gap-3">
          <h3 className="section-header flex-1">{t("projects:backups")}</h3>
          <button disabled={busy} onClick={() => void run(() => api.admin.backup(id))} className="btn-link text-sm">
            {t("projects:backupNow")}
          </button>
        </div>
        <ul className="mt-1 text-xs text-fg-secondary">
          {project.backups.map((b) => (
            <li key={b.key}>
              {formatDateTime(b.createdAt)} · {b.reason} · {fileSize(b.bytes)}
            </li>
          ))}
          {!project.backups.length && <li className="text-fg-muted">{t("projects:noBackups")}</li>}
        </ul>
      </section>

      <section>
        <h2 className="section-header">{t("app:nav.users")}</h2>
        <ul className="mt-2 divide-y divide-line">
          {project.memberList.map((m) => (
            <li key={m.userId} className="flex items-center justify-between gap-3 py-2 text-sm">
              <span className="min-w-0 truncate">
                {m.name ?? m.email ?? m.userId}
                {m.name && m.email && <span className="text-fg-muted"> · {m.email}</span>}
              </span>
              <span className="flex shrink-0 items-center gap-3">
                <select
                  value={m.role}
                  disabled={busy}
                  onChange={(e) => void run(() => api.admin.setMember(id, m.userId, e.target.value as Role))}
                  className="field w-auto py-1"
                >
                  <option value="member">{t("role.member")}</option>
                  <option value="admin">{t("role.admin")}</option>
                </select>
                <button
                  disabled={busy}
                  title={t("projects:reset2faHint")}
                  onClick={() => window.confirm(t("projects:reset2faConfirm", { name: m.name ?? m.email })) && void run(() => api.admin.resetSecondFactor(m.userId))}
                  className="btn-link"
                >
                  {t("projects:reset2fa")}
                </button>
                <button disabled={busy} onClick={() => void run(() => api.admin.removeMember(id, m.userId))} className="btn-danger">
                  {t("remove")}
                </button>
              </span>
            </li>
          ))}
          {!project.memberList.length && <li className="py-2 text-sm text-fg-muted">{t("projects:noMembers")}</li>}
        </ul>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await api.admin.setMember(id, newUser, newRole);
              setNewUser("");
            });
          }}
          className="mt-3 flex flex-wrap gap-2"
        >
          <select value={newUser} onChange={(e) => setNewUser(e.target.value)} required className="field min-w-0 flex-1">
            <option value="">{t("projects:addUser")}</option>
            {candidates.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name ?? u.email ?? u.id}
                {u.name && u.email ? ` (${u.email})` : ""}
              </option>
            ))}
          </select>
          <select value={newRole} onChange={(e) => setNewRole(e.target.value as Role)} className="field w-auto">
            <option value="member">{t("role.member")}</option>
            <option value="admin">{t("role.admin")}</option>
          </select>
          <button disabled={busy || !newUser} className="btn-primary">
            {t("add")}
          </button>
        </form>
        {link && <LoginLink who={link.who} url={link.url} />}
        <InviteForm
          onInvite={(body) =>
            run(async () => {
              const result = await api.admin.invite(id, body);
              if (result.loginLink) setLink({ who: body.email, url: result.loginLink });
            })
          }
        />
        <p className="mt-1 text-xs text-fg-muted">{t("projects:inviteHint")}</p>
      </section>

      {error && <p className="notice notice-error px-3 py-2 text-sm">{error}</p>}

      <section className="border-t border-line pt-6">
        <h2 className="section-header text-error">{t("projects:remove")}</h2>
        <p className="mt-1 text-sm text-fg-secondary">
          {t("projects:removeHint")}
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setBusy(true);
            setError(undefined);
            api.admin.deleteProject(id).then(onDeleted, (err: Error) => {
              setError(err.message);
              setBusy(false);
            });
          }}
          className="mt-2 flex gap-2"
        >
          <input value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder={t("projects:removeConfirm", { id: project.id })} className="field min-w-0 flex-1" />
          <button disabled={busy || confirm !== project.id} className="btn-danger">
            {t("remove")}
          </button>
        </form>
      </section>
    </div>
  );
}

/** The system admin's project administration: the projects on the left, the chosen one's `ProjectPanel` or the form for a new one on the right. */
export function ProjectAdmin({
  projects,
  initial,
  onChanged,
}: {
  projects: ProjectSummary[];
  /** The project to open, or `null` for the form of a new one. */
  initial?: string | null;
  /** A project was created, changed or deleted. */
  onChanged: () => void;
}) {
  // A project's id, or `null` for a new one.
  const [selected, setSelected] = useState<string | null>(initial !== undefined ? initial : (projects[0]?.id ?? null));

  return (
    <div className="flex h-full">
      <nav className="flex w-60 shrink-0 flex-col border-e border-line p-2 text-sm">
        <h2 className="section-header px-2 py-1">{t("app:nav.projects")}</h2>
        <div className="mt-1 min-h-0 flex-1 overflow-y-auto">
          {projects.map((t) => (
            <button key={t.id} onClick={() => setSelected(t.id)} data-active={selected === t.id} className="list-row flex w-full items-center gap-2 px-2 py-1.5 text-start">
              <ProjectLogo project={t} size={20} />
              <span className="min-w-0 flex-1 truncate">
                {t.name} <span className="text-xs text-fg-muted">· {t.id}</span>
              </span>
            </button>
          ))}
          {!projects.length && <p className="px-2 py-1.5 text-fg-muted">{t("noneYet")}</p>}
          <button onClick={() => setSelected(null)} data-active={selected === null} className="list-row mt-1 w-full px-2 py-1.5 text-start text-primary">
            <Icon name="add" className="me-1 h-4 w-4 align-[-0.2em]" />{t("projects:create")}
          </button>
        </div>
      </nav>
      <div className="min-w-0 flex-1">
        {selected ? (
          <ProjectPanel
            key={selected}
            id={selected}
            onChanged={onChanged}
            onDeleted={() => {
              setSelected(null);
              onChanged();
            }}
          />
        ) : (
          <NewProject
            onCreated={(id) => {
              setSelected(id);
              onChanged();
            }}
          />
        )}
      </div>
    </div>
  );
}

/** The project's logo, or its initial when there is none or it fails to load. */
export function ProjectLogo({ project, size = 32 }: { project: { name: string; logo: string | null }; size?: number }) {
  const [failed, setFailed] = useState(false);
  const style = { width: size, height: size, fontSize: size * 0.45 };
  if (project.logo && !failed) {
    return <img src={project.logo} alt="" style={style} onError={() => setFailed(true)} className="shrink-0 rounded-sm object-contain" />;
  }
  return (
    <span style={style} className="flex shrink-0 items-center justify-center rounded-sm bg-secondary-soft font-semibold text-secondary">
      {initial(project.name)}
    </span>
  );
}

/** Which web analytics sites (web-events) the project sees on its Weby dashboard, besides those of its domains. */
function WebSitesForm({ sites, busy, onSave }: { sites: string[]; busy: boolean; onSave: (sites: string[]) => void }) {
  const [text, setText] = useState(sites.join("\n"));
  const parsed = [...new Set(text.split(/[\s,]+/).map((s) => s.trim().toLowerCase()).filter(Boolean))];
  return (
    <form onSubmit={(e) => (e.preventDefault(), onSave(parsed))} className="mt-4 space-y-2">
      <h3 className="section-header">{t("projects:webSites")}</h3>
      <p className="text-xs text-fg-muted">{t("projects:webSitesHint")}</p>
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} className="field w-full max-w-md font-mono text-xs" />
      <button disabled={busy || parsed.join() === sites.join()} className="btn-secondary">
        {t("projects:saveWebSites")}
      </button>
    </form>
  );
}
