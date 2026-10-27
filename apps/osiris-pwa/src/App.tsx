import type {
  DocumentSummary,
  McpServer,
  Memory,
  MeResponse,
  Scope,
  SecretSummary,
  SkillSummary,
  ProjectFeatures,
  ProjectInfo as Project,
  ProjectSummary,
  ProjectUsage,
  ThreadSummary,
} from "@osiris/shared";
import { t } from "i18next";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { api, setProject } from "./api.ts";
import { getAccessToken, login, logout } from "./auth.ts";
import { ChatPane } from "./chat/ChatPane.tsx";
import { LayeredFiles } from "./Files.tsx";
import { Schedules } from "./Schedules.tsx";
import { Database } from "./Database.tsx";
import { Dashboards } from "./Dashboards.tsx";
import { Sites } from "./Sites.tsx";
import { PublicAssistants } from "./PublicAssistant.tsx";
import { PublicChat } from "./PublicChat.tsx";
import { documentKey, KnowledgeDetail } from "./Knowledge.tsx";
import { MCP_SIGN_IN, mcpKey, McpServerDetail, McpStatus } from "./McpServers.tsx";
import { INTEGRATION_RETURN } from "./Integrations.tsx";
import { MemoryDetail, memoryKey } from "./Memories.tsx";
import { Avatar, Profile } from "./Profile.tsx";
import { Loading, OverriddenBadge, Pending, ScopeBadge, Splash } from "./Scope.tsx";
import { SecretDetail, secretKey } from "./Secrets.tsx";
import { loadSkills, SkillDetail, skillKey } from "./Skills.tsx";
import { Members, roleLabel, ProjectInfo } from "./ProjectInfo.tsx";
import { SystemSettings } from "./SystemSettings.tsx";
import { WebAnalytics } from "./WebAnalytics.tsx";
import { ProjectAdmin, ProjectLogo } from "./Projects.tsx";
import { StatusBar } from "./Quotas.tsx";
import { BuiltinTools } from "./Tools.tsx";
import { UserAdmin } from "./Users.tsx";
import { MasterDetail } from "./MasterDetail.tsx";
import { Guards } from "./Guards.tsx";
import { fromPath, LAST_PATH, toPath, type Section, type View } from "./routes.ts";

export function App() {
  // The sign-in screen, where the identity provider (/auth) sends the browser.
  // A project's public assistant for its customers, without signing in (also inside widget.js).
  const publicChat = /^\/c\/([a-z0-9-]+)(?:\/([a-z0-9-]+))?\/?$/.exec(location.pathname);
  if (publicChat) return <PublicChat project={publicChat[1]!} assistant={publicChat[2]} />;
  return <Gate />;
}

function Gate() {
  const [loggedIn, setLoggedIn] = useState<boolean>();
  const [loginError, setLoginError] = useState<string>();
  useEffect(() => void getAccessToken().then((t) => setLoggedIn(!!t)), []);

  if (loggedIn === undefined) return <Splash />;
  if (!loggedIn) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 bg-canvas px-4">
        <img src="/logo.svg" alt="" className="h-28 w-28" />
        <h1 className="text-4xl font-semibold tracking-[0.2em]">OSIRIS</h1>
        <button
          onClick={() => login().catch((e: Error) => setLoginError(t("app:loginFailed", { detail: e.message })))}
          className="btn-primary px-6 py-3"
        >
          {t("app:signIn")}
        </button>
        {loginError && <p className="notice notice-error max-w-md px-3 py-2 text-sm">{loginError}</p>}
      </div>
    );
  }
  return <Workspace />;
}

interface Lists {
  knowledge: DocumentSummary[];
  skills: SkillSummary[];
  memory: Memory[];
  mcp: McpServer[];
  secrets: SecretSummary[];
}

const EMPTY: Lists = { knowledge: [], skills: [], memory: [], mcp: [], secrets: [] };

const LOADERS: { [S in Section]: () => Promise<Lists[S]> } = {
  knowledge: api.documents,
  skills: loadSkills,
  memory: api.memories,
  mcp: api.mcpServers,
  secrets: api.secrets,
};

/** Labels are read when shown (`label()`, `add()`), so they follow the current language. */
const SECTIONS: { id: Section; label: () => string; add: () => string; icon: string; enabled: (f: ProjectFeatures) => boolean }[] = [
  { id: "knowledge", label: () => t("app:nav.knowledge"), add: () => t("app:add.knowledge"), icon: "M2 3h5l1 1 1-1h5v10H9l-1 1-1-1H2zM8 4v9", enabled: (f) => f.knowledge },
  { id: "skills", label: () => t("app:nav.skills"), add: () => t("app:add.skills"), icon: "M3 4h10M3 8h10M3 12h6", enabled: (f) => f.skills },
  { id: "memory", label: () => t("app:nav.memory"), add: () => t("app:add.memory"), icon: "M8 2a4 4 0 0 0-2 7.5V11h4V9.5A4 4 0 0 0 8 2zM6.5 13.5h3", enabled: (f) => f.memory },
  { id: "mcp", label: () => t("app:nav.mcp"), add: () => t("app:add.mcp"), icon: "M6 2v3M10 2v3M4 5h8v3a4 4 0 0 1-8 0zM8 12v2", enabled: (f) => f.mcp },
  { id: "secrets", label: () => t("app:nav.secrets"), add: () => t("app:add.secrets"), icon: "M10 2a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM7 9l-5 5M4 12l1.5 1.5", enabled: (f) => f.http || f.mcp },
];

interface Row {
  key: string;
  label: string;
  badge?: ReactNode;
}

/**
 * A record's marks in the list: the viewer's own, replaced by their own copy, or bundled. The project's are the
 * default and unmarked.
 */
const layerBadge = (r: { scope?: Scope | "bundled"; overridden?: boolean }, extra?: ReactNode) =>
  r.overridden || r.scope === "personal" || r.scope === "bundled" || extra ? (
    <span className="flex items-center gap-1">
      {r.overridden ? <OverriddenBadge /> : r.scope && r.scope !== "project" && <ScopeBadge scope={r.scope} />}
      {extra}
    </span>
  ) : undefined;

function rows(section: Section, lists: Lists): Row[] {
  switch (section) {
    case "knowledge":
      return lists.knowledge.map((d) => ({ key: documentKey(d), label: d.title, badge: layerBadge(d) }));
    case "skills":
      return lists.skills.map((s) => ({ key: skillKey(s), label: s.name, badge: layerBadge({ scope: s.source, overridden: s.overridden }) }));
    case "memory":
      return lists.memory.map((m) => ({ key: memoryKey(m), label: m.content, badge: layerBadge(m) }));
    case "mcp":
      return lists.mcp.map((s) => ({ key: mcpKey(s), label: s.name, badge: layerBadge(s, s.overridden ? undefined : <McpStatus server={s} />) }));
    case "secrets":
      return lists.secrets.map((s) => ({ key: secretKey(s), label: s.name, badge: layerBadge(s) }));
  }
}

const LAST_PROJECT = "osiris.project";
const SIDEBAR_COLLAPSED = "osiris.sidebarCollapsed";

/** Phone-sized screens: the sidebar starts as icons and opens over the content as a drawer. */
const NARROW = "(max-width: 767px)";
const isNarrow = () => window.matchMedia?.(NARROW).matches ?? false;
function useNarrow() {
  const [narrow, setNarrow] = useState(isNarrow);
  useEffect(() => {
    const query = window.matchMedia?.(NARROW);
    if (!query) return;
    const change = () => setNarrow(query.matches);
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, []);
  return narrow;
}

/** Per-browser conveniences only; the app works the same when storage is unavailable. */
const stored = <T,>(key: string, fallback: T): T => {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
};
const store = (key: string, value: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Ignored, see `stored`.
  }
};

function Workspace() {
  const [me, setMe] = useState<MeResponse>();
  const [project, setProjectInfo] = useState<Project>();
  // Undefined while they load.
  const [threads, setThreads] = useState<ThreadSummary[]>();
  const [lists, setLists] = useState<Lists>(EMPTY);
  // Sections whose list has come (the rest show a loading veil).
  const [loaded, setLoaded] = useState<ReadonlySet<Section>>(new Set());
  // The system admin's project administration.
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  // The active project's quotas and their use, shown in the status bar.
  const [usage, setUsage] = useState<ProjectUsage>();
  // Not fatal: the meters just stay out.
  const refreshUsage = () => api.usage().then(setUsage, () => setUsage(undefined));
  // `?profile=security` comes back from linking a social account (or a first sign-in by link): open the profile.
  const [notice] = useState(() => {
    const params = new URLSearchParams(location.search);
    if (!params.has("profile")) return undefined;
    history.replaceState(null, "", "/");
    return { linked: params.get("linked") ?? undefined, error: params.get("error") ?? undefined };
  });
  // Back from an MCP server's OAuth sign-in (/mcp-callback): finished once the project it started in is open.
  const [mcpReturn] = useState(() => {
    if (location.pathname !== "/mcp-callback") return undefined;
    const params = new URLSearchParams(location.search);
    history.replaceState(null, "", "/");
    let started: { project?: string; name?: string; scope?: Scope } = {};
    try {
      started = JSON.parse(sessionStorage.getItem(MCP_SIGN_IN) ?? "{}");
      sessionStorage.removeItem(MCP_SIGN_IN);
    } catch {
      // Without it the sign-in still finishes, in the last project.
    }
    if (started.project) store(LAST_PROJECT, started.project);
    return { ...started, code: params.get("code"), state: params.get("state"), iss: params.get("iss") ?? undefined, error: params.get("error_description") ?? params.get("error") };
  });
  // Back from connecting a Google or Microsoft account (/integration-callback), in the project it started in.
  const [integrationReturn] = useState(() => {
    if (location.pathname !== "/integration-callback") return undefined;
    const params = new URLSearchParams(location.search);
    history.replaceState(null, "", "/");
    let started: { project?: string } = {};
    try {
      started = JSON.parse(sessionStorage.getItem(INTEGRATION_RETURN) ?? "{}");
      sessionStorage.removeItem(INTEGRATION_RETURN);
    } catch {
      // Without it the connection still finishes, in the last project.
    }
    if (started.project) store(LAST_PROJECT, started.project);
    return { ...started, code: params.get("code"), state: params.get("state"), error: params.get("error_description") ?? params.get("error") };
  });
  const narrow = useNarrow();
  // On a phone the sidebar always starts as icons; elsewhere as the user left it.
  const [collapsed, setCollapsed] = useState(() => isNarrow() || stored(SIDEBAR_COLLAPSED, false));
  // Where to start: the URL, else (the installed app opens at /) where the user last was in this sign-in.
  const [route] = useState(() => {
    if (notice || integrationReturn) return { view: { kind: "profile" } as View };
    if (mcpReturn) return undefined;
    const r = fromPath(location.pathname) ?? (location.pathname === "/" ? fromPath(stored(LAST_PATH, "")) : undefined);
    if (r?.project) store(LAST_PROJECT, r.project);
    return r;
  });
  const [view, setView] = useState<View>(route?.view ?? { kind: "chat", threadId: null, session: 0 });
  // On a phone the sidebar drawer closes once something in it was chosen, and when the screen turns narrow.
  useEffect(() => {
    if (narrow) setCollapsed(true);
  }, [narrow, view]);
  const [error, setError] = useState<string>();

  const refreshThreads = useCallback(() => api.threads().then(setThreads, (e: Error) => setError(e.message)), []);
  const refresh = (section: Section) =>
    LOADERS[section]().then(
      (items) => {
        setLists((l) => ({ ...l, [section]: items }));
        setLoaded((l) => new Set(l).add(section));
        return items;
      },
      (e: Error) => setError(e.message),
    );
  const refreshProjects = () => api.admin.projects().then(setProjects, (e: Error) => setError(e.message));


  const loadProject = () =>
    api.project().then((t) => {
      setProjectInfo(t);
      for (const s of SECTIONS) if (s.enabled(t.features)) void refresh(s.id);
    }, (e: Error) => setError(e.message));

  /** Opens a project; `keep` keeps the view (it came from the URL), otherwise a new chat starts. */
  const selectProject = (id: string, keep = false) => {
    setProject(id);
    store(LAST_PROJECT, id);
    setProjectInfo(undefined);
    setLists(EMPTY);
    setLoaded(new Set());
    setThreads(undefined);
    setUsage(undefined);
    void loadProject();
    void refreshUsage();
    // The profile stays open (it may have been opened from a link); everything else starts a new chat.
    if (!keep) setView((v) => (v.kind === "profile" ? v : { kind: "chat", threadId: null, session: (v.kind === "chat" ? v.session : 0) + 1 }));
    void refreshThreads();
  };

  /** Loads who the user is and keeps the current project if it's still theirs (it may have just been removed). */
  const loadMe = (current?: string) =>
    api.me().then((m) => {
      setMe(m);
      if (m.systemAdmin) void refreshProjects();
      const ids = m.projects.map((t) => t.id);
      const pick = [current, stored<string | null>(LAST_PROJECT, null)].find((id) => id && ids.includes(id)) ?? ids[0];
      if (!pick) {
        // A system admin with no project yet starts with creating one.
        setProjectInfo(undefined);
        if (m.systemAdmin) setView({ kind: "projects", initial: null });
      } else if (pick !== current) selectProject(pick, current === undefined && (!route?.project || route.project === pick));
    }, (e: Error) => setError(e.message));

  useEffect(() => void loadMe(), []);
  const [mcpDone, setMcpDone] = useState(false);
  // A problem that doesn't stop the app, shown above the main area until dismissed.
  const [flash, setFlash] = useState<string>();
  useEffect(() => {
    if (!mcpReturn || mcpDone || !project || (mcpReturn.project && project.id !== mcpReturn.project)) return;
    setMcpDone(true);
    const fail = (message: string) => setFlash(t("app:mcpSignInFailed", { detail: message }));
    if (mcpReturn.error || !mcpReturn.code || !mcpReturn.state) return fail(mcpReturn.error ?? t("app:noCode"));
    api.finishMcpSignIn({ state: mcpReturn.state, code: mcpReturn.code, iss: mcpReturn.iss }).then(
      async (done) => {
        await api.testMcpServer(done.name, done.scope).catch(() => {});
        await refresh("mcp");
        setView({ kind: "item", section: "mcp", id: mcpKey({ scope: done.scope, name: done.name }) });
      },
      (e: Error) => fail(e.message),
    );
  }, [project, mcpReturn, mcpDone]);
  const [integrationDone, setIntegrationDone] = useState(false);
  // Bumped when an account got connected, so the profile reloads its list.
  const [connections, setConnections] = useState(0);
  useEffect(() => {
    if (!integrationReturn || integrationDone || !project || (integrationReturn.project && project.id !== integrationReturn.project)) return;
    setIntegrationDone(true);
    const fail = (message: string) => setFlash(t("app:integrationFailed", { detail: message }));
    if (integrationReturn.error || !integrationReturn.code || !integrationReturn.state) return fail(integrationReturn.error ?? t("app:noCode"));
    api.finishIntegration({ state: integrationReturn.state, code: integrationReturn.code }).then(
      () => (setConnections((n) => n + 1), setView({ kind: "profile" })),
      (e: Error) => fail(e.message),
    );
  }, [project, integrationReturn, integrationDone]);
  // The view in the URL: a new entry per navigation, replaced when a new chat gets its thread.
  const projectId = project?.id;
  const shown = useRef<{ path: string; view: View }>(undefined);
  useEffect(() => {
    const path = toPath(view, projectId);
    if (!path) return;
    store(LAST_PATH, path);
    const prev = shown.current;
    shown.current = { path, view };
    if (path === location.pathname) return;
    const sameChat = prev?.view.kind === "chat" && view.kind === "chat" && prev.view.session === view.session;
    if (!prev || sameChat) history.replaceState(null, "", path);
    else history.pushState(null, "", path);
  }, [view, projectId]);
  // Back and forward: the URL's view, in its project.
  const current = useRef({ projectId, selectProject });
  current.current = { projectId, selectProject };
  useEffect(() => {
    const onPop = () => {
      const r = fromPath(location.pathname);
      if (!r) return;
      if (r.project && r.project !== current.current.projectId) current.current.selectProject(r.project, true);
      setView((v) => (r.view.kind === "chat" ? { ...r.view, session: (v.kind === "chat" ? v.session : 0) + 1 } : r.view));
    };
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);
  // Visits per view for GoatCounter (when the gateway added its script): the view's kind and section, never ids.
  const viewPath = view.kind === "list" || view.kind === "item" ? `/${view.section}` : `/${view.kind}`;
  useEffect(() => window.goatcounter?.count?.({ path: viewPath }), [viewPath]);

  const openThread = (threadId: string | null) =>
    setView((v) => ({ kind: "chat", threadId, session: (v.kind === "chat" ? v.session : 0) + 1 }));

  const removeThread = async (id: string) => {
    await api.deleteThread(id);
    if (view.kind === "chat" && view.threadId === id) openThread(null);
    await refreshThreads();
  };

  if (error) {
    return (
      <div className="m-6 max-w-2xl space-y-3">
        <p className="notice notice-error px-3 py-2 text-sm whitespace-pre-wrap">{error}</p>
        <button onClick={logout} className="btn-secondary">
          {t("app:signOut")}
        </button>
      </div>
    );
  }
  if (!me) return <Splash />;
  const isAdmin = project?.role === "admin";
  // A local agent (`osiris <folder>`): one project, one user, without the server's parts.
  const local = me?.mode === "local";
  const sections = project ? SECTIONS.filter((s) => s.enabled(project.features)) : [];
  // Everyone adds their own records; admins also the project's.
  const canAdd = (_section: Section) => true;
  /** After a save the record is shown. */
  const showSaved = (section: Section, key: string) => void refresh(section).then(() => setView({ kind: "item", section, id: key }));
  /** A sidebar link to a section, when the project has its feature. */
  const sectionLink = (id: Section) => {
    const s = sections.find((x) => x.id === id);
    return (
      s && (
        <NavLink
          active={(view.kind === "list" || view.kind === "item") && view.section === id}
          onClick={() => setView({ kind: "list", section: id })}
          label={s.label()}
          icon={s.icon}
          count={rows(id, lists).length}
        />
      )
    );
  };
  const toggleSidebar = () => setCollapsed((c) => (narrow || store(SIDEBAR_COLLAPSED, !c), !c));
  const drawer = narrow && !collapsed;

  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-0 flex-1">
        {/* Collapsed: icons only; `side-label` parts hide. On a phone the open sidebar lies over the content. */}
        {drawer && (
          <>
            <div className="w-16 shrink-0" aria-hidden="true" />
            <button type="button" className="fixed inset-0 z-30 bg-black/30" onClick={() => setCollapsed(true)} aria-label={t("app:collapse")} />
          </>
        )}
        <aside
          data-collapsed={collapsed}
          className={`group/side flex shrink-0 flex-col border-e border-line bg-sidebar text-sm ${collapsed ? "w-16" : "w-72"} ${drawer ? "fixed inset-y-0 start-0 z-40 max-w-[85vw] shadow-xl" : ""}`}
        >
          <div className={`flex items-center gap-2 pt-3 ${collapsed ? "flex-col px-2" : "px-3"}`}>
            <img src="/logo.svg" alt="" className="h-8 w-8" />
            {/* Centred between the logo and the toggle; the letter spacing also follows the last letter, so it's taken back. */}
            {!collapsed && (
              <span className="flex flex-1 justify-center text-xl leading-none font-semibold">
                <span className="-mr-[0.2em] tracking-[0.2em]">OSIRIS</span>
              </span>
            )}
            <button onClick={toggleSidebar} className="list-row p-1.5 text-fg-secondary" aria-label={collapsed ? t("app:expand") : t("app:collapse")} title={collapsed ? t("app:expand") : t("app:collapse")}>
              <svg viewBox="0 0 16 16" className="h-5 w-5" aria-hidden="true">
                <path d={collapsed ? "M2 3h12v10H2zM6 3v10M8.5 6.5 10 8l-1.5 1.5" : "M2 3h12v10H2zM6 3v10M11 6.5 9.5 8 11 9.5"} fill="none" stroke="currentColor" strokeWidth="1.3" />
              </svg>
            </button>
          </div>
          {project && collapsed && (
            <button onClick={() => openThread(null)} className="btn-primary mx-auto mt-3 flex h-10 w-10 items-center justify-center p-0" aria-label={t("app:newChat")} title={t("app:newChat")}>
              <svg viewBox="0 0 16 16" className="h-5 w-5" aria-hidden="true">
                <path d="M8 3v10M3 8h10" fill="none" stroke="currentColor" strokeWidth="1.6" />
              </svg>
            </button>
          )}
          {project && !collapsed && (
            <button onClick={() => openThread(null)} className="btn-primary mx-3 mt-3">
              + {t("app:newChat")}
            </button>
          )}
          <nav className="mt-3 min-h-0 flex-1 overflow-y-auto px-2 pb-3">
            {project && collapsed && (
              <NavLink active={view.kind === "chat"} onClick={() => (toggleSidebar())} label={t("app:nav.conversations")} icon="M2 4h12v7H9l-3 3v-3H2z" />
            )}
            {project && !collapsed && (
              <section className="relative min-h-16">
                <Loading show={!threads} />
                <h2 className="section-header flex items-center gap-1 px-2 py-1">
                  {t("app:nav.conversations")} {!!threads?.length && <span className="font-normal text-fg-muted">{threads.length}</span>}
                </h2>
                {threads?.map((th) => (
                  <div key={th.id} data-active={view.kind === "chat" && view.threadId === th.id} className="list-row group flex items-center px-2">
                    <button onClick={() => openThread(th.id)} className="flex-1 truncate py-1.5 text-start">
                      {th.channel === "whatsapp" && <span className="me-1 text-fg-muted" title="WhatsApp">WA</span>}
                      {th.title ?? t("app:newChat")}
                    </button>
                    <button onClick={() => removeThread(th.id)} className="hidden px-1 text-fg-muted hover:text-error group-hover:block" aria-label={t("delete")}>
                      ×
                    </button>
                  </div>
                ))}
                {threads && !threads.length && <p className="px-2 py-1.5 text-fg-muted">{t("noneYet")}</p>}
              </section>
            )}
            {project && (
              <NavSection title={t("app:nav.context")}>
                {sectionLink("knowledge")}
                {sectionLink("memory")}
                {project.features.files && <NavLink active={view.kind === "files"} onClick={() => setView({ kind: "files" })} label={t("app:nav.files")} icon="M2 4h4l1.5 1.5H14V13H2z" />}
                {sectionLink("mcp")}
                {sectionLink("skills")}
                <NavLink active={view.kind === "guards"} onClick={() => setView({ kind: "guards" })} label={t("app:nav.guards")} icon="M8 1.5 13.5 3.5v4c0 3.2-2.3 5.8-5.5 7-3.2-1.2-5.5-3.8-5.5-7v-4zM5.5 8l2 2 3-3.5" />
                {sectionLink("secrets")}
              </NavSection>
            )}
            {project && (
              <NavSection title={t("app:nav.project")}>
                {!local && <NavLink active={view.kind === "dashboard"} onClick={() => setView({ kind: "dashboard" })} label={t("app:nav.dashboard")} icon="M2 2h5v6H2zM9 2h5v3H9zM9 7h5v7H9zM2 10h5v4H2z" />}
                {project.features.public && <NavLink active={view.kind === "public"} onClick={() => setView({ kind: "public" })} label={t("app:nav.assistants")} icon="M2 4h12v7H6l-3 3V4z" />}
                {project.features.database && (
                  <NavLink active={view.kind === "database"} onClick={() => setView({ kind: "database" })} label={t("app:nav.database")} icon="M8 2c3.3 0 6 .9 6 2v8c0 1.1-2.7 2-6 2s-6-.9-6-2V4c0-1.1 2.7-2 6-2zM2 4c0 1.1 2.7 2 6 2s6-.9 6-2M2 8c0 1.1 2.7 2 6 2s6-.9 6-2" />
                )}
                {project.features.scheduler && (
                  <NavLink active={view.kind === "schedules"} onClick={() => setView({ kind: "schedules" })} label={t("app:nav.schedules")} icon="M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2zm0 3v3.5l2.5 1.5" />
                )}
                {!local && (
                  <NavLink
                    active={view.kind === "users"}
                    onClick={() => (me.systemAdmin && void refreshProjects(), setView({ kind: "users" }))}
                    label={t("app:nav.users")}
                    icon="M6 7a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM1.5 14c0-2.5 2-4.5 4.5-4.5s4.5 2 4.5 4.5M11 2.5a2.5 2.5 0 0 1 0 4.5M12.5 9.7c1.2.6 2 2 2 3.8"
                  />
                )}
                {project.features.sites && (
                  <NavLink active={view.kind === "sites"} onClick={() => setView({ kind: "sites" })} label={t("app:nav.sites")} icon="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2z" />
                )}
                {project.features.sites && !local && (
                  <NavLink active={view.kind === "analytics"} onClick={() => setView({ kind: "analytics" })} label={t("app:nav.analytics")} icon="M2 13.5h12M4 11V8M8 11V4M12 11V6.5" />
                )}
              </NavSection>
            )}
            {me.systemAdmin && (
              <NavSection title={t("app:nav.system")}>
                <NavLink active={view.kind === "sysdash"} onClick={() => setView({ kind: "sysdash" })} label={t("app:nav.dashboard")} icon="M2 2h5v6H2zM9 2h5v3H9zM9 7h5v7H9zM2 10h5v4H2z" />
                <NavLink active={view.kind === "projects"} onClick={() => setView({ kind: "projects" })} label={t("app:nav.projects")} icon="M2 3h12v4H2zM2 9h12v4H2zM4.5 5h.01M4.5 11h.01" />
                <NavLink
                  active={view.kind === "settings"}
                  onClick={() => setView({ kind: "settings" })}
                  label={t("app:nav.settings")}
                  icon="M12.83 6.72L14.51 6.92L14.51 9.08L12.83 9.28L12.32 10.51L13.37 11.84L11.84 13.37L10.51 12.32L9.28 12.83L9.08 14.51L6.92 14.51L6.72 12.83L5.49 12.32L4.16 13.37L2.63 11.84L3.68 10.51L3.17 9.28L1.49 9.08L1.49 6.92L3.17 6.72L3.68 5.49L2.63 4.16L4.16 2.63L5.49 3.68L6.72 3.17L6.92 1.49L9.08 1.49L9.28 3.17L10.51 3.68L11.84 2.63L13.37 4.16L12.32 5.49zM8 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"
                />
              </NavSection>
            )}
          </nav>

          <div className="border-t border-line p-2">
            <ProjectSwitcher me={me} project={project} active={view.kind === "project"} onOpen={() => setView({ kind: "project" })} onSelect={selectProject} />
            <button
              onClick={() => setView({ kind: "profile" })}
              data-active={view.kind === "profile"}
              title={collapsed ? (me.user.name ?? me.user.email ?? undefined) : undefined}
              className="list-row flex w-full items-center gap-3 px-2 py-2 text-start"
            >
              <Avatar user={me.user} />
              <span className="side-label min-w-0 flex-1">
                <span className="block truncate font-medium">{me.user.name ?? me.user.email}</span>
                {me.user.name && me.user.email && <span className="block truncate text-xs text-fg-muted">{me.user.email}</span>}
              </span>
            </button>
          </div>
        </aside>

        <main className="relative h-full min-w-0 flex-1 bg-canvas">
          {flash && (
            <div className="notice notice-error absolute inset-x-3 top-3 z-10 flex items-start gap-3 px-3 py-2 text-sm">
              <span className="flex-1">{flash}</span>
              <button onClick={() => setFlash(undefined)} aria-label={t("close")} className="text-fg-secondary">
                ×
              </button>
            </div>
          )}
          {view.kind === "sysdash" ? (
            me.systemAdmin ? <Dashboards key="system" system canEdit me={me.user} /> : null
          ) : view.kind === "settings" ? (
            me.systemAdmin ? <SystemSettings part={view.part} onSelect={(part) => setView({ kind: "settings", part })} /> : null
          ) : view.kind === "users" ? (
            <ProjectUsers key={project?.id} me={me} isAdmin={isAdmin} projects={projects} />
          ) : view.kind === "projects" ? (
            <ProjectAdmin
              projects={projects}
              initial={view.initial}
              onChanged={() => {
                void refreshProjects();
                void loadMe(project?.id);
                // The current project's name, logo or features may have changed.
                if (project) void loadProject();
              }}
            />
          ) : view.kind === "project" ? (
            <ProjectInfo
              me={me}
              project={project}
              onChanged={() => {
                void loadProject();
                void loadMe(project?.id);
                if (me.systemAdmin) void refreshProjects();
              }}
            />
          ) : view.kind === "profile" ? (
            <Profile key={`${project?.id}:${connections}`} me={me} notice={notice} features={project?.features} />
          ) : !project ? (
            // The project is on its way (a system admin without any has nothing to wait for).
            me.projects.length ? <Pending className="relative h-full" /> : null
          ) : view.kind === "files" ? (
            project.features.files ? (
              <LayeredFiles key={project.id} isAdmin={isAdmin} intro={t("app:filesIntro")} />
            ) : null
          ) : view.kind === "schedules" ? (
            project.features.scheduler ? <Schedules key={project.id} isAdmin={isAdmin} onOpenThread={(id) => (openThread(id), void refreshThreads())} /> : null
          ) : view.kind === "dashboard" ? (
            <Dashboards key={project.id} system={false} canEdit={isAdmin} me={me.user} />
          ) : view.kind === "analytics" ? (
            project.features.sites ? <WebAnalytics key={project.id} /> : null
          ) : view.kind === "database" ? (
            project.features.database ? <Database key={project.id} isAdmin={isAdmin} /> : null
          ) : view.kind === "public" ? (
            project.features.public ? <PublicAssistants key={project.id} projectId={project.id} isAdmin={isAdmin} /> : null
          ) : view.kind === "guards" ? (
            <Guards key={project.id} isAdmin={isAdmin} systemAdmin={me.systemAdmin} />
          ) : view.kind === "sites" ? (
            project.features.sites ? <Sites key={project.id} isAdmin={isAdmin} /> : null
          ) : view.kind === "list" || view.kind === "item" ? (
            <SectionPanel
              key={`${project.id}:${view.section}`}
              view={view}
              lists={lists}
              loading={!loaded.has(view.section)}
              canAdd={canAdd(view.section)}
              setView={setView}
              tools={view.section === "mcp" ? <BuiltinTools key={project.id} projectId={project.id} systemAdmin={me.systemAdmin} /> : undefined}
            >
              {view.kind === "item" && (
                <Detail
                  key={`${project.id}:${view.section}:${view.id ?? "new"}`}
                  section={view.section}
                  id={view.id}
                  lists={lists}
                  scope={isAdmin ? "project" : "personal"}
                  isAdmin={isAdmin}
                  onSaved={(key) => showSaved(view.section, key)}
                  onDeleted={() => void refresh(view.section).then(() => setView({ kind: "list", section: view.section }))}
                />
              )}
            </SectionPanel>
          ) : (
            <ChatPane
              key={`${project.id}:${view.session}`}
              threadId={view.threadId}
              onThreadCreated={(id) => setView((v) => (v.kind === "chat" ? { ...v, threadId: id } : v))}
              onRunFinished={() => (void refreshThreads(), void refreshUsage())}
            />
          )}
        </main>
      </div>
      <StatusBar project={project?.name} role={project ? roleLabel(project.role) : undefined} usage={project ? usage : undefined} />
    </div>
  );
}

/**
 * The active project at the bottom of the sidebar, with its logo. A click opens the project's detail; with more than
 * one project, a click while the detail is open opens a menu of the projects to switch to (closed by a click elsewhere
 * or Esc).
 */
function ProjectSwitcher({
  me,
  project,
  active,
  onOpen,
  onSelect,
}: {
  me: MeResponse;
  project?: Project;
  active: boolean;
  onOpen: () => void;
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const menu = me.projects.length > 1;
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  const pick = (action: () => void) => () => {
    setOpen(false);
    action();
  };

  return (
    <div ref={ref} className="relative">
      <button
        onClick={menu && (active || open) ? () => setOpen((o) => !o) : onOpen}
        data-active={active || open}
        aria-haspopup={menu ? "menu" : undefined}
        aria-expanded={menu ? open : undefined}
        className="list-row flex w-full items-center gap-3 px-2 py-2 text-start"
      >
        <ProjectLogo project={project ?? { name: "?", logo: null }} />
        <span className="side-label min-w-0 flex-1">
          <span className="block truncate text-base font-semibold">{project?.name ?? t("app:noProject")}</span>
          <span className="block truncate text-xs text-fg-muted">{project ? roleLabel(project.role) : t("app:chooseProject")}</span>
        </span>
      </button>
      {open && (
        <div role="menu" className="absolute bottom-full start-0 w-64 z-10 mb-1 max-h-96 overflow-y-auto rounded-md border border-line bg-canvas p-1 shadow-[var(--shadow-popup)]">
          {me.projects.map((t) => (
            <button
              key={t.id}
              role="menuitemradio"
              aria-checked={t.id === project?.id}
              data-active={t.id === project?.id}
              onClick={pick(() => t.id !== project?.id && onSelect(t.id))}
              className="list-row flex w-full items-center gap-2 px-2 py-1.5 text-start"
            >
              <ProjectLogo project={t} size={24} />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{t.name}</span>
                <span className="block truncate text-xs text-fg-muted">
                  {t.id} · {roleLabel(t.role)}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** A group of sidebar links under a title; collapsed, only a line between groups. */
function NavSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-4">
      <h2 className="side-label px-2 pb-1 text-[11px] font-semibold tracking-[0.08em] text-fg-muted uppercase">{title}</h2>
      <div className="hidden border-t border-line group-data-[collapsed=true]/side:block" />
      {children}
    </section>
  );
}

/** The project's people (its admins manage them); system admins can switch to everyone in Osiris. */
function ProjectUsers({ me, isAdmin, projects }: { me: MeResponse; isAdmin: boolean; projects: ProjectSummary[] }) {
  const [all, setAll] = useState(false);
  return (
    <div className="flex h-full flex-col">
      {me.systemAdmin && (
        <div className="flex gap-1 border-b border-line px-4 py-2 text-sm">
          <button data-active={!all} onClick={() => setAll(false)} className="list-row px-3 py-1">
            {t("app:users.thisProject")}
          </button>
          <button data-active={all} onClick={() => setAll(true)} className="list-row px-3 py-1">
            {t("app:users.all")}
          </button>
        </div>
      )}
      <div className="min-h-0 flex-1">
        {all ? (
          <UserAdmin self={me.user.id} projects={projects} />
        ) : isAdmin ? (
          <div className="detail">
            <Members self={me.user.id} />
          </div>
        ) : (
          <p className="detail text-sm text-fg-secondary">{t("app:users.adminManages")}</p>
        )}
      </div>
    </div>
  );
}

/** A sidebar link: an icon with its label, only the icon (and a tooltip) while the sidebar is collapsed. */
function NavLink({ active, onClick, label, icon, count }: { active: boolean; onClick: () => void; label: string; icon: string; count?: number }) {
  return (
    <button
      onClick={onClick}
      data-active={active}
      title={label}
      aria-label={label}
      className="section-header list-row mt-1 flex w-full items-center gap-2 px-2 py-1.5 text-start group-data-[collapsed=true]/side:justify-center"
    >
      <svg viewBox="0 0 16 16" className="h-5 w-5 shrink-0" aria-hidden="true">
        <path d={icon} fill="none" stroke="currentColor" strokeWidth="1.3" />
      </svg>
      <span className="side-label truncate">{label}</span>
      {!!count && <span className="side-label font-normal text-fg-muted">{count}</span>}
    </button>
  );
}

/** The tools' entry of the MCP section, above its servers. */
const BUILTIN_TOOLS = " tools";

/** A section's records in the secondary panel, the chosen record's detail (`children`) on the right. */
function SectionPanel(props: {
  view: Extract<View, { kind: "list" | "item" }>;
  lists: Lists;
  canAdd: boolean;
  setView: (v: View) => void;
  /** The MCP section's built-in tools, shown when no server is chosen. */
  tools?: ReactNode;
  /** The section's list is on its way. */
  loading: boolean;
  children?: ReactNode;
}) {
  const { view, setView } = props;
  const section = SECTIONS.find((s) => s.id === view.section)!;
  const items = rows(view.section, props.lists).map((r) => ({ key: r.key, label: r.label, badge: r.badge }));
  const selected = view.kind === "item" ? view.id : props.tools ? BUILTIN_TOOLS : undefined;
  return (
    <MasterDetail
      title={section.label()}
      top={<p className="px-2 text-xs text-fg-muted">{t("scope.layered")}</p>}
      groups={
        props.tools
          ? [{ items: [{ key: BUILTIN_TOOLS, label: t("app:builtinTools") }] }, { title: t("app:mcpServers"), items, empty: t("noneYet") }]
          : [{ items, empty: t("nothingYet") }]
      }
      selected={selected}
      loading={props.loading}
      onSelect={(id) => setView(id === BUILTIN_TOOLS ? { kind: "list", section: view.section } : { kind: "item", section: view.section, id })}
      add={props.canAdd ? { label: section.add(), onClick: () => setView({ kind: "item", section: view.section, id: null }) } : undefined}
    >
      {props.children || (props.tools && <div className="detail">{props.tools}</div>) || undefined}
    </MasterDetail>
  );
}

function Detail({
  section,
  id,
  lists,
  ...props
}: {
  section: Section;
  id: string | null;
  lists: Lists;
  scope: Scope;
  isAdmin: boolean;
  onSaved: (key: string) => void;
  onDeleted: () => void;
}) {
  const find = <T,>(items: T[], key: (item: T) => string) => (id === null ? undefined : items.find((i) => key(i) === id));
  // A record that is gone (removed elsewhere, or the list is still loading) shows nothing rather than the "new" form.
  const missing = <T,>(item: T | undefined) => id !== null && !item;
  switch (section) {
    case "knowledge": {
      const item = find(lists.knowledge, documentKey);
      return missing(item) ? null : <KnowledgeDetail item={item} {...props} />;
    }
    case "skills": {
      const item = find(lists.skills, skillKey);
      return missing(item) ? null : <SkillDetail item={item} {...props} />;
    }
    case "memory": {
      const item = find(lists.memory, memoryKey);
      return missing(item) ? null : <MemoryDetail item={item} {...props} />;
    }
    case "mcp": {
      const item = find(lists.mcp, mcpKey);
      return missing(item) ? null : <McpServerDetail item={item} {...props} />;
    }
    case "secrets": {
      const item = find(lists.secrets, secretKey);
      return missing(item) ? null : <SecretDetail item={item} {...props} />;
    }
  }
}

declare global {
  interface Window {
    /** GoatCounter's count.js, when the gateway serves the page with it. */
    goatcounter?: { count?: (vars: { path: string; title?: string }) => void };
  }
}
