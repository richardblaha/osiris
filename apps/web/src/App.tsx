import type {
  DocumentSummary,
  McpServer,
  Memory,
  MeResponse,
  Scope,
  SecretSummary,
  SkillSummary,
  TenantFeatures,
  TenantInfo as Tenant,
  TenantSummary,
  TenantUsage,
  ThreadSummary,
} from "@osiris/shared";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { api, setTenant } from "./api.ts";
import { getAccessToken, login, logout } from "./auth.ts";
import { ChatPane } from "./chat/ChatPane.tsx";
import { Files } from "./Files.tsx";
import { Schedules } from "./Schedules.tsx";
import { Sites } from "./Sites.tsx";
import { documentKey, KnowledgeDetail } from "./Knowledge.tsx";
import { MCP_SIGN_IN, mcpKey, McpServerDetail, McpStatus } from "./McpServers.tsx";
import { INTEGRATION_RETURN } from "./Integrations.tsx";
import { MemoryDetail, memoryKey } from "./Memories.tsx";
import { Avatar, Profile } from "./Profile.tsx";
import { ScopeBadge } from "./Scope.tsx";
import { SignIn } from "./SignIn.tsx";
import { SecretDetail, secretKey } from "./Secrets.tsx";
import { loadSkills, SkillDetail, skillKey } from "./Skills.tsx";
import { roleLabel, TenantInfo } from "./TenantInfo.tsx";
import { TenantAdmin, TenantLogo } from "./Tenants.tsx";
import { QuotaMeters } from "./Quotas.tsx";
import { BuiltinTools } from "./Tools.tsx";
import { UserAdmin } from "./Users.tsx";

export function App() {
  // The sign-in screen, where the identity provider (/auth) sends the browser.
  if (location.pathname === "/login") return <SignIn />;
  return <Gate />;
}

function Gate() {
  const [loggedIn, setLoggedIn] = useState<boolean>();
  const [loginError, setLoginError] = useState<string>();
  useEffect(() => void getAccessToken().then((t) => setLoggedIn(!!t)), []);

  if (loggedIn === undefined) return null;
  if (!loggedIn) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 bg-canvas px-4">
        <img src="/logo.svg" alt="" className="h-28 w-28" />
        <h1 className="text-4xl font-semibold tracking-[0.2em]">OSIRIS</h1>
        <button
          onClick={() => login().catch((e: Error) => setLoginError(`Přihlášení selhalo: ${e.message}`))}
          className="btn-primary px-6 py-3"
        >
          Přihlásit se
        </button>
        {loginError && <p className="notice notice-error max-w-md px-3 py-2 text-sm">{loginError}</p>}
      </div>
    );
  }
  return <Workspace />;
}

/** Sidebar sections whose records open as a detail form. */
type Section = "knowledge" | "skills" | "memory" | "mcp" | "secrets";

type View =
  | { kind: "chat"; threadId: string | null; session: number }
  /** A section's records in the sidebar tab's scope. */
  | { kind: "list"; section: Section }
  /** A record of a section by its key, or `null` for the form of a new one. */
  | { kind: "item"; section: Section; id: string | null }
  | { kind: "profile" }
  | { kind: "tenant" }
  /** The system admin's tenant administration, opening a tenant (or `null`: the form of a new one). */
  | { kind: "tenants"; initial?: string | null }
  /** The system admin's user administration. */
  | { kind: "users" }
  | { kind: "files" }
  | { kind: "schedules" }
  | { kind: "sites" };

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

const SECTIONS: { id: Section; label: string; add: string; icon: string; enabled: (f: TenantFeatures) => boolean }[] = [
  { id: "knowledge", label: "Znalostní báze", add: "Přidat dokument", icon: "M2 3h5l1 1 1-1h5v10H9l-1 1-1-1H2zM8 4v9", enabled: (f) => f.knowledge },
  { id: "skills", label: "Dovednosti", add: "Přidat dovednost", icon: "M3 4h10M3 8h10M3 12h6", enabled: (f) => f.skills },
  { id: "memory", label: "Paměť", add: "Přidat záznam", icon: "M8 2a4 4 0 0 0-2 7.5V11h4V9.5A4 4 0 0 0 8 2zM6.5 13.5h3", enabled: (f) => f.memory },
  { id: "mcp", label: "Nástroje a MCP", add: "Přidat MCP server", icon: "M6 2v3M10 2v3M4 5h8v3a4 4 0 0 1-8 0zM8 12v2", enabled: (f) => f.mcp },
  { id: "secrets", label: "Klíče a hesla", add: "Přidat klíč", icon: "M10 2a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM7 9l-5 5M4 12l1.5 1.5", enabled: (f) => f.http || f.mcp },
];

interface Row {
  key: string;
  label: string;
  /** Which tab lists it: bundled skills belong with the tenant's. */
  scope: Scope;
  badge?: ReactNode;
}

const tabOf = (scope: Scope | "bundled"): Scope => (scope === "personal" ? "personal" : "tenant");

function rows(section: Section, lists: Lists): Row[] {
  switch (section) {
    case "knowledge":
      return lists.knowledge.map((d) => ({ key: documentKey(d), label: d.title, scope: d.scope }));
    case "skills":
      return lists.skills.map((s) => ({
        key: skillKey(s),
        label: s.name,
        scope: tabOf(s.source),
        badge: s.source === "bundled" ? <ScopeBadge scope="bundled" /> : undefined,
      }));
    case "memory":
      return lists.memory.map((m) => ({ key: memoryKey(m), label: m.content, scope: m.scope }));
    case "mcp":
      return lists.mcp.map((s) => ({ key: mcpKey(s), label: s.name, scope: s.scope, badge: <McpStatus server={s} /> }));
    case "secrets":
      return lists.secrets.map((s) => ({ key: secretKey(s), label: s.name, scope: s.scope }));
  }
}

const LAST_TENANT = "osiris.tenant";
const SCOPE_TAB = "osiris.scope";

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
  const [tenant, setTenantInfo] = useState<Tenant>();
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [lists, setLists] = useState<Lists>(EMPTY);
  // The system admin's tenant administration.
  const [tenants, setTenants] = useState<TenantSummary[]>([]);
  // The active tenant's quotas and their use, shown above it in the sidebar.
  const [usage, setUsage] = useState<TenantUsage>();
  // Not fatal: the meters just stay out.
  const refreshUsage = () => api.usage().then(setUsage, () => setUsage(undefined));
  // `?profile=security` comes back from linking a social account (or a first sign-in by link): open the profile.
  const [notice] = useState(() => {
    const params = new URLSearchParams(location.search);
    if (!params.has("profile")) return undefined;
    history.replaceState(null, "", "/");
    return { linked: params.get("linked") ?? undefined, error: params.get("error") ?? undefined };
  });
  // Back from an MCP server's OAuth sign-in (/mcp-callback): finished once the tenant it started in is open.
  const [mcpReturn] = useState(() => {
    if (location.pathname !== "/mcp-callback") return undefined;
    const params = new URLSearchParams(location.search);
    history.replaceState(null, "", "/");
    let started: { tenant?: string; name?: string; scope?: Scope } = {};
    try {
      started = JSON.parse(sessionStorage.getItem(MCP_SIGN_IN) ?? "{}");
      sessionStorage.removeItem(MCP_SIGN_IN);
    } catch {
      // Without it the sign-in still finishes, in the last tenant.
    }
    if (started.tenant) store(LAST_TENANT, started.tenant);
    return { ...started, code: params.get("code"), state: params.get("state"), iss: params.get("iss") ?? undefined, error: params.get("error_description") ?? params.get("error") };
  });
  // Back from connecting a Google or Microsoft account (/integration-callback), in the tenant it started in.
  const [integrationReturn] = useState(() => {
    if (location.pathname !== "/integration-callback") return undefined;
    const params = new URLSearchParams(location.search);
    history.replaceState(null, "", "/");
    let started: { tenant?: string } = {};
    try {
      started = JSON.parse(sessionStorage.getItem(INTEGRATION_RETURN) ?? "{}");
      sessionStorage.removeItem(INTEGRATION_RETURN);
    } catch {
      // Without it the connection still finishes, in the last tenant.
    }
    if (started.tenant) store(LAST_TENANT, started.tenant);
    return { ...started, code: params.get("code"), state: params.get("state"), error: params.get("error_description") ?? params.get("error") };
  });
  const [view, setView] = useState<View>(notice || integrationReturn ? { kind: "profile" } : { kind: "chat", threadId: null, session: 0 });
  // The sidebar's tab: tenant-wide or the user's own records, files and settings.
  const [scope, setScope] = useState<Scope>(() => (stored<string>(SCOPE_TAB, "personal") === "tenant" ? "tenant" : "personal"));
  const [error, setError] = useState<string>();

  const refreshThreads = useCallback(() => api.threads().then(setThreads, (e: Error) => setError(e.message)), []);
  const refresh = (section: Section) =>
    LOADERS[section]().then(
      (items) => {
        setLists((l) => ({ ...l, [section]: items }));
        return items;
      },
      (e: Error) => setError(e.message),
    );
  const refreshTenants = () => api.admin.tenants().then(setTenants, (e: Error) => setError(e.message));


  const loadTenant = () =>
    api.tenant().then((t) => {
      setTenantInfo(t);
      for (const s of SECTIONS) if (s.enabled(t.features)) void refresh(s.id);
    }, (e: Error) => setError(e.message));

  const selectTenant = (id: string) => {
    setTenant(id);
    store(LAST_TENANT, id);
    setTenantInfo(undefined);
    setLists(EMPTY);
    setUsage(undefined);
    void loadTenant();
    void refreshUsage();
    // The profile stays open (it may have been opened from a link); everything else starts a new chat.
    setView((v) => (v.kind === "profile" ? v : { kind: "chat", threadId: null, session: (v.kind === "chat" ? v.session : 0) + 1 }));
    void refreshThreads();
  };

  /** Loads who the user is and keeps the current tenant if it's still theirs (it may have just been removed). */
  const loadMe = (current?: string) =>
    api.me().then((m) => {
      setMe(m);
      if (m.systemAdmin) void refreshTenants();
      const ids = m.tenants.map((t) => t.id);
      const pick = [current, stored<string | null>(LAST_TENANT, null)].find((id) => id && ids.includes(id)) ?? ids[0];
      if (!pick) {
        // A system admin with no tenant yet starts with creating one.
        setTenantInfo(undefined);
        if (m.systemAdmin) setView({ kind: "tenants", initial: null });
      } else if (pick !== current) selectTenant(pick);
    }, (e: Error) => setError(e.message));

  useEffect(() => void loadMe(), []);
  const [mcpDone, setMcpDone] = useState(false);
  // A problem that doesn't stop the app, shown above the main area until dismissed.
  const [flash, setFlash] = useState<string>();
  useEffect(() => {
    if (!mcpReturn || mcpDone || !tenant || (mcpReturn.tenant && tenant.id !== mcpReturn.tenant)) return;
    setMcpDone(true);
    const fail = (message: string) => setFlash(`Přihlášení k MCP serveru se nepodařilo: ${message}`);
    if (mcpReturn.error || !mcpReturn.code || !mcpReturn.state) return fail(mcpReturn.error ?? "poskytovatel nevrátil kód");
    api.finishMcpSignIn({ state: mcpReturn.state, code: mcpReturn.code, iss: mcpReturn.iss }).then(
      async (done) => {
        await api.testMcpServer(done.name, done.scope).catch(() => {});
        await refresh("mcp");
        setScope(done.scope);
        setView({ kind: "item", section: "mcp", id: mcpKey({ scope: done.scope, name: done.name }) });
      },
      (e: Error) => fail(e.message),
    );
  }, [tenant, mcpReturn, mcpDone]);
  const [integrationDone, setIntegrationDone] = useState(false);
  // Bumped when an account got connected, so the profile reloads its list.
  const [connections, setConnections] = useState(0);
  useEffect(() => {
    if (!integrationReturn || integrationDone || !tenant || (integrationReturn.tenant && tenant.id !== integrationReturn.tenant)) return;
    setIntegrationDone(true);
    const fail = (message: string) => setFlash(`Propojení účtu se nepodařilo: ${message}`);
    if (integrationReturn.error || !integrationReturn.code || !integrationReturn.state) return fail(integrationReturn.error ?? "poskytovatel nevrátil kód");
    api.finishIntegration({ state: integrationReturn.state, code: integrationReturn.code }).then(
      () => (setConnections((n) => n + 1), setView({ kind: "profile" })),
      (e: Error) => fail(e.message),
    );
  }, [tenant, integrationReturn, integrationDone]);
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
          Odhlásit
        </button>
      </div>
    );
  }
  if (!me) return null;
  const isAdmin = tenant?.role === "admin";
  const sections = tenant ? SECTIONS.filter((s) => s.enabled(tenant.features)) : [];
  const scoped = (section: Section) => rows(section, lists).filter((r) => r.scope === scope);
  const switchScope = (next: Scope) => {
    setScope(next);
    store(SCOPE_TAB, next);
    // A record belongs to one tab; its section's list in the other tab takes its place.
    setView((v) => (v.kind === "item" ? { kind: "list", section: v.section } : v));
  };
  /** After a save the record is shown, in its own tab (a member's copy of a tenant skill is personal). */
  const showSaved = (section: Section, key: string) =>
    void refresh(section).then((items) => {
      const saved = items && rows(section, { ...lists, [section]: items }).find((r) => r.key === key);
      if (saved && saved.scope !== scope) {
        setScope(saved.scope);
        store(SCOPE_TAB, saved.scope);
      }
      setView({ kind: "item", section, id: key });
    });
  const hasScoped = !!tenant && (tenant.features.files || sections.length > 0);

  return (
    <div className="flex h-full">
      <aside className="flex w-72 shrink-0 flex-col border-r border-line bg-sidebar text-sm">
        <div className="flex items-center gap-2 px-3 pt-3">
          <img src="/logo.svg" alt="" className="h-8 w-8" />
          <span className="text-xl font-semibold tracking-[0.2em]">OSIRIS</span>
        </div>
        {tenant && (
          <button onClick={() => openThread(null)} className="btn-primary mx-3 mt-3">
            + Nový chat
          </button>
        )}
        <nav className="mt-3 min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {tenant && (
            <section>
              <h2 className="section-header flex items-center gap-1 px-2 py-1">
                Konverzace {threads.length > 0 && <span className="font-normal text-fg-muted">{threads.length}</span>}
              </h2>
              {threads.map((t) => (
                <div key={t.id} data-active={view.kind === "chat" && view.threadId === t.id} className="list-row group flex items-center px-2">
                  <button onClick={() => openThread(t.id)} className="flex-1 truncate py-1.5 text-left">
                    {t.channel === "whatsapp" && <span className="mr-1 text-fg-muted">WA</span>}
                    {t.title ?? "Nový chat"}
                  </button>
                  <button onClick={() => removeThread(t.id)} className="hidden px-1 text-fg-muted hover:text-error group-hover:block" aria-label="Smazat">
                    ×
                  </button>
                </div>
              ))}
              {!threads.length && <p className="px-2 py-1.5 text-fg-muted">Zatím žádné.</p>}
            </section>
          )}
          {hasScoped && (
            <>
              <div role="tablist" aria-label="Pro koho" className="mt-3 grid grid-cols-2 gap-1 rounded-md bg-hover p-0.5">
                {(["tenant", "personal"] as const).map((t) => (
                  <button
                    key={t}
                    role="tab"
                    aria-selected={scope === t}
                    onClick={() => switchScope(t)}
                    className={`rounded-sm px-2 py-1 font-medium ${scope === t ? "bg-canvas text-fg shadow-sm" : "text-fg-secondary hover:text-fg"}`}
                  >
                    {t === "tenant" ? "Pro tenanta" : "Pro mě"}
                  </button>
                ))}
              </div>
              {tenant?.features.files && (
                <NavLink active={view.kind === "files"} onClick={() => setView({ kind: "files" })} label="Soubory" icon="M2 4h4l1.5 1.5H14V13H2z" />
              )}
              {sections.map((s) => (
                <NavLink
                  key={s.id}
                  active={(view.kind === "list" || view.kind === "item") && view.section === s.id}
                  onClick={() => setView({ kind: "list", section: s.id })}
                  label={s.label}
                  icon={s.icon}
                  count={scoped(s.id).length}
                />
              ))}
            </>
          )}
          {(tenant?.features.scheduler || tenant?.features.sites) && <div className="mt-3 border-t border-line" />}
          {tenant?.features.scheduler && (
            <NavLink active={view.kind === "schedules"} onClick={() => setView({ kind: "schedules" })} label="Plánované úlohy" icon="M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2zm0 3v3.5l2.5 1.5" />
          )}
          {tenant?.features.sites && (
            <NavLink active={view.kind === "sites"} onClick={() => setView({ kind: "sites" })} label="Web" icon="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2z" />
          )}
        </nav>

        <div className="border-t border-line p-2">
          {tenant && usage && <QuotaMeters usage={usage} />}
          <TenantSwitcher
            me={me}
            tenant={tenant}
            active={view.kind === "tenant" || view.kind === "tenants" || view.kind === "users"}
            onOpen={() => setView({ kind: "tenant" })}
            onManage={() => setView({ kind: "tenants" })}
            onManageUsers={() => (void refreshTenants(), setView({ kind: "users" }))}
            onSelect={selectTenant}
          />
          <button onClick={() => setView({ kind: "profile" })} data-active={view.kind === "profile"} className="list-row flex w-full items-center gap-3 px-2 py-2 text-left">
            <Avatar user={me.user} />
            <span className="min-w-0 flex-1">
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
            <button onClick={() => setFlash(undefined)} aria-label="Zavřít" className="text-fg-secondary">
              ×
            </button>
          </div>
        )}
        {view.kind === "users" ? (
          <UserAdmin self={me.user.id} tenants={tenants} />
        ) : view.kind === "tenants" ? (
          <TenantAdmin
            tenants={tenants}
            initial={view.initial}
            onChanged={() => {
              void refreshTenants();
              void loadMe(tenant?.id);
              // The current tenant's name, logo or features may have changed.
              if (tenant) void loadTenant();
            }}
          />
        ) : view.kind === "tenant" ? (
          <TenantInfo
            me={me}
            tenant={tenant}
            onChanged={() => {
              void loadTenant();
              void loadMe(tenant?.id);
              if (me.systemAdmin) void refreshTenants();
            }}
          />
        ) : view.kind === "profile" ? (
          <Profile key={`${tenant?.id}:${connections}`} me={me} notice={notice} features={tenant?.features} />
        ) : !tenant ? null : view.kind === "files" ? (
          tenant.features.files ? <Files key={`${tenant.id}:${scope}`} scope={scope} isAdmin={isAdmin} /> : null
        ) : view.kind === "schedules" ? (
          tenant.features.scheduler ? <Schedules key={tenant.id} isAdmin={isAdmin} onOpenThread={(id) => (openThread(id), void refreshThreads())} /> : null
        ) : view.kind === "sites" ? (
          tenant.features.sites ? <Sites key={tenant.id} isAdmin={isAdmin} /> : null
        ) : view.kind === "list" ? (
          <SectionList
            title={SECTIONS.find((s) => s.id === view.section)!.label}
            add={SECTIONS.find((s) => s.id === view.section)!.add}
            scope={scope}
            canAdd={scope === "personal" || isAdmin}
            rows={scoped(view.section)}
            onOpen={(id) => setView({ kind: "item", section: view.section, id })}
            // Built-in tools are the tenant's, so they're listed in its tab, above the tenant's MCP servers.
            before={view.section === "mcp" && scope === "tenant" ? <BuiltinTools key={tenant.id} tenantId={tenant.id} systemAdmin={me.systemAdmin} /> : undefined}
            listTitle={view.section === "mcp" ? "MCP servery" : undefined}
          />
        ) : view.kind === "item" ? (
          <div className="flex h-full flex-col">
            <button
              onClick={() => setView({ kind: "list", section: view.section })}
              className="mx-auto w-full max-w-3xl px-6 pt-4 text-left text-sm text-fg-secondary hover:text-primary"
            >
              ← {SECTIONS.find((s) => s.id === view.section)!.label}
            </button>
            <div className="min-h-0 flex-1">
              <Detail
                key={`${tenant.id}:${view.section}:${view.id ?? "new"}`}
                section={view.section}
                id={view.id}
                lists={lists}
                scope={scope}
                isAdmin={isAdmin}
                onSaved={(key) => showSaved(view.section, key)}
                onDeleted={() => void refresh(view.section).then(() => setView({ kind: "list", section: view.section }))}
              />
            </div>
          </div>
        ) : (
          <ChatPane
            key={`${tenant.id}:${view.session}`}
            threadId={view.threadId}
            onThreadCreated={(id) => setView((v) => (v.kind === "chat" ? { ...v, threadId: id } : v))}
            onRunFinished={() => (void refreshThreads(), void refreshUsage())}
          />
        )}
      </main>
    </div>
  );
}

/**
 * The active tenant at the bottom of the sidebar, with its logo. With more than one tenant (or tenant administration
 * to reach) it opens a menu: the tenants to switch to, the tenant's detail and, for system admins, the administration
 * (closed by a click elsewhere or Esc); otherwise it opens the tenant's detail.
 */
function TenantSwitcher({
  me,
  tenant,
  active,
  onOpen,
  onManage,
  onManageUsers,
  onSelect,
}: {
  me: MeResponse;
  tenant?: Tenant;
  active: boolean;
  onOpen: () => void;
  onManage: () => void;
  onManageUsers: () => void;
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const menu = me.tenants.length > 1 || me.systemAdmin;
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
        onClick={menu ? () => setOpen((o) => !o) : onOpen}
        data-active={active || open}
        aria-haspopup={menu ? "menu" : undefined}
        aria-expanded={menu ? open : undefined}
        className="list-row flex w-full items-center gap-3 px-2 py-2 text-left"
      >
        <TenantLogo tenant={tenant ?? { name: "?", logo: null }} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-base font-semibold">{tenant?.name ?? "Žádný tenant"}</span>
          <span className="block truncate text-xs text-fg-muted">{tenant ? roleLabel(tenant.role) : "vyber nebo založ tenanta"}</span>
        </span>
      </button>
      {open && (
        <div role="menu" className="absolute inset-x-0 bottom-full z-10 mb-1 max-h-96 overflow-y-auto rounded-md border border-line bg-canvas p-1 shadow-[var(--shadow-popup)]">
          {me.tenants.map((t) => (
            <button
              key={t.id}
              role="menuitemradio"
              aria-checked={t.id === tenant?.id}
              data-active={t.id === tenant?.id}
              onClick={pick(() => t.id !== tenant?.id && onSelect(t.id))}
              className="list-row flex w-full items-center gap-2 px-2 py-1.5 text-left"
            >
              <TenantLogo tenant={t} size={24} />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{t.name}</span>
                <span className="block truncate text-xs text-fg-muted">
                  {t.id} · {roleLabel(t.role)}
                </span>
              </span>
            </button>
          ))}
          <div className="my-1 border-t border-line" />
          {tenant && (
            <button role="menuitem" onClick={pick(onOpen)} className="list-row block w-full px-2 py-1.5 text-left">
              O tenantovi
            </button>
          )}
          {me.systemAdmin && (
            <>
              <button role="menuitem" onClick={pick(onManage)} className="list-row block w-full px-2 py-1.5 text-left">
                Správa tenantů
              </button>
              <button role="menuitem" onClick={pick(onManageUsers)} className="list-row block w-full px-2 py-1.5 text-left">
                Správa uživatelů
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function NavLink({ active, onClick, label, icon, count }: { active: boolean; onClick: () => void; label: string; icon: string; count?: number }) {
  return (
    <button onClick={onClick} data-active={active} className="section-header list-row mt-2 flex w-full items-center gap-1 px-2 py-1 text-left">
      <svg viewBox="0 0 16 16" className="h-3 w-3" aria-hidden="true">
        <path d={icon} fill="none" stroke="currentColor" strokeWidth="1.4" />
      </svg>
      {label}
      {!!count && <span className="font-normal text-fg-muted">{count}</span>}
    </button>
  );
}

/** A section's records in the sidebar tab's scope; a record opens its detail form. */
function SectionList(props: {
  title: string;
  add: string;
  scope: Scope;
  canAdd: boolean;
  rows: Row[];
  onOpen: (id: string | null) => void;
  /** Shown above the records, e.g. the built-in tools above the MCP servers. */
  before?: ReactNode;
  listTitle?: string;
}) {
  return (
    <div className="detail">
      <div className="flex items-center gap-3">
        <h1 className="min-w-0 flex-1 text-lg font-semibold">
          {props.title} <ScopeBadge scope={props.scope} />
        </h1>
        {props.canAdd && (
          <button onClick={() => props.onOpen(null)} className="btn-primary">
            + {props.add}
          </button>
        )}
      </div>
      <p className="mt-1 text-xs text-fg-muted">
        {props.scope === "personal" ? "Platí jen pro tebe." : props.canAdd ? "Platí pro všechny v tenantovi." : "Platí pro všechny v tenantovi. Měnit je může jen správce tenanta."}
      </p>
      {props.before}
      {props.listTitle && <h2 className="section-header mt-6">{props.listTitle}</h2>}
      <ul className={`${props.listTitle ? "mt-1" : "mt-4"} text-sm`}>
        {props.rows.map((r) => (
          <li key={r.key}>
            <button onClick={() => props.onOpen(r.key)} className="list-row flex w-full items-center gap-2 px-2 py-2 text-left">
              <span className="min-w-0 flex-1 truncate">{r.label}</span>
              {r.badge && <span className="flex shrink-0 gap-1">{r.badge}</span>}
            </button>
          </li>
        ))}
      </ul>
      {!props.rows.length && <p className="px-2 py-2 text-sm text-fg-muted">Zatím nic.</p>}
    </div>
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
