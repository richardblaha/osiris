import { FEATURES, type MeResponse, type ProjectInfo as Project, type ProjectMember } from "@osiris/shared";
import { useEffect, useState } from "react";
import { api } from "./api.ts";
import { MasterDetail } from "./MasterDetail.tsx";
import { InviteForm } from "./Invite.tsx";
import { attempt, ErrorNotice, Loading } from "./Scope.tsx";
import { featureLabels, ProjectLogo } from "./Projects.tsx";
import { t } from "i18next";
import { Trans } from "react-i18next";
import { GitPanel } from "./Git.tsx";

export const roleLabel = (role: Project["role"]) => (role === "admin" ? t("role.admin") : t("role.member"));

/** The active project: its overview (admins set its logo) and the features it has, each a part of its own. */
export function ProjectInfo({ me, project, onChanged }: { me: MeResponse; project?: Project; onChanged: () => void }) {
  const [part, setPart] = useState<"overview" | "features" | "git">("overview");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  if (!project) return <h1 className="detail text-lg font-semibold">{t("app:noProject")}</h1>;
  return (
    <MasterDetail
      title={project.name}
      groups={[
        {
          items: [
            { key: "overview", label: t("projectInfo:overview") },
            { key: "features", label: t("projectInfo:features") },
            ...(project.role === "admin" && project.features.files ? [{ key: "git", label: t("projectInfo:git.title") }] : []),
          ],
        },
      ]}
      selected={part}
      onSelect={(k) => setPart(k as typeof part)}
    >
      {part === "overview" ? (
        <div className="detail">
          <div className="flex items-center gap-3">
            <ProjectLogo project={project} size={48} />
            <h1 className="min-w-0 flex-1 text-lg font-semibold break-words">{project.name}</h1>
            {project.role === "admin" && (
              <label className={`btn-secondary cursor-pointer ${busy ? "pointer-events-none opacity-60" : ""}`}>
                {t("projectInfo:changeLogo")}
                <input
                  type="file"
                  accept="image/png,image/jpeg"
                  hidden
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = "";
                    if (file) void attempt(setBusy, setError, async () => (await api.saveProjectLogo(file), onChanged()));
                  }}
                />
              </label>
            )}
          </div>
          <ErrorNotice error={error} />
          <dl className="notice mt-6 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 px-3 py-2 text-sm">
            <dt className="text-fg-secondary">{t("projects:slug")}</dt>
            <dd>{project.id}</dd>
            <dt className="text-fg-secondary">{t("projectInfo:myRole")}</dt>
            <dd>
              {roleLabel(project.role)}
              {me.systemAdmin && <span className="text-fg-muted"> · {t("role.systemAdmin")}</span>}
            </dd>
            <dt className="text-fg-secondary">{t("projectInfo:permissions")}</dt>
            <dd>
              <code>{me.systemAdmin ? "role=osiris-admin" : `${project.role === "admin" ? "project-admin" : "project"}=${project.id}`}</code>
            </dd>
          </dl>
        </div>
      ) : part === "git" ? (
        <GitPanel key={project.id} />
      ) : (
        <div className="detail">
          <h1 className="text-lg font-semibold">{t("projectInfo:features")}</h1>
          <ul className="mt-3 space-y-1 text-sm">
            {FEATURES.map((f) => (
              <li key={f} className={project.features[f] ? "" : "text-fg-muted line-through"}>
                {featureLabels()[f].label} <span className="text-fg-muted">· {featureLabels()[f].hint}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-fg-muted">{t("projectInfo:featuresHint")}</p>
        </div>
      )}
    </MasterDetail>
  );
}

/** A project admin's view of the project's people: roles, removal, invitations and new sign-in links. */
export function Members({ self }: { self: string }) {
  const [members, setMembers] = useState<ProjectMember[]>();
  const [link, setLink] = useState<{ who: string; url: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const load = () => api.members().then(setMembers, (e: Error) => setError(e.message));
  useEffect(() => void load(), []);
  const act = (action: () => Promise<unknown>) => attempt(setBusy, setError, async () => (await action(), await load()));

  return (
    <section className="relative">
      <Loading show={!members && !error} />
      <h1 className="text-lg font-semibold">{t("projectInfo:members")}</h1>
      <ul className="mt-2 divide-y divide-line">
        {members?.map((m) => (
          <li key={m.userId} className="flex flex-wrap items-center justify-between gap-3 py-2 text-sm">
            <span className="min-w-0 truncate">
              {m.name ?? m.email ?? m.userId}
              {m.name && m.email && <span className="text-fg-muted"> · {m.email}</span>}
            </span>
            {m.userId !== self && (
              <span className="flex shrink-0 items-center gap-3">
                <select
                  value={m.role}
                  disabled={busy}
                  onChange={(e) => void act(() => api.setMemberRole(m.userId, e.target.value as ProjectMember["role"]))}
                  className="field w-auto py-1"
                >
                  <option value="member">{t("role.member")}</option>
                  <option value="admin">{t("role.admin")}</option>
                </select>
                <button
                  disabled={busy}
                  onClick={() => void attempt(setBusy, setError, async () => setLink({ who: m.name ?? m.email ?? m.userId, url: (await api.loginLink(m.userId)).loginLink }))}
                  className="btn-link"
                >
                  {t("projectInfo:loginLink")}
                </button>
                <button disabled={busy} onClick={() => window.confirm(t("projectInfo:confirmRemove", { name: m.name ?? m.email })) && void act(() => api.removeMember(m.userId))} className="btn-danger">
                  {t("remove")}
                </button>
              </span>
            )}
          </li>
        ))}
      </ul>
      {link && <LoginLink who={link.who} url={link.url} />}
      <InviteForm
        onInvite={async (body) => {
          const result = await api.invite(body);
          await load();
          if (result.loginLink) setLink({ who: body.email, url: result.loginLink });
        }}
      />
      <ErrorNotice error={error} />
    </section>
  );
}

export function LoginLink({ who, url }: { who: string; url: string }) {
  return (
    <div className="notice mt-3 space-y-1 px-3 py-2 text-sm">
      <p>
        <Trans ns="projectInfo" i18nKey="loginLinkFor" values={{ who }} components={{ strong: <strong /> }} />
      </p>
      <div className="flex gap-2">
        <input readOnly value={url} className="field min-w-0 flex-1 text-xs" onFocus={(e) => e.target.select()} />
        <button onClick={() => void navigator.clipboard.writeText(url)} className="btn-secondary text-sm">
          {t("copy")}
        </button>
      </div>
    </div>
  );
}
