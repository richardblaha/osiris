import type { MeResponse, Scope, TenantFeatures, TenantInfo, ThreadSummary } from "@osiris/shared";
import { useCallback, useEffect, useState } from "react";
import { api, setTenant } from "./api.ts";
import { configError, getAccessToken, login, logout } from "./auth.ts";
import { ChatPane } from "./chat/ChatPane.tsx";
import { Knowledge } from "./Knowledge.tsx";
import { McpServers } from "./McpServers.tsx";
import { Memories } from "./Memories.tsx";
import { Profile } from "./Profile.tsx";
import type { ScopedProps } from "./Scope.tsx";
import { Secrets } from "./Secrets.tsx";
import { Skills } from "./Skills.tsx";
import { Tenants } from "./Tenants.tsx";

type View =
  | { kind: "chat"; threadId: string | null; session: number }
  | { kind: "settings"; page: Page; scope: Scope }
  | { kind: "profile" }
  | { kind: "tenants" };

export function App() {
  const [loggedIn, setLoggedIn] = useState<boolean>();
  const [loginError, setLoginError] = useState(configError);
  useEffect(() => void getAccessToken().then((t) => setLoggedIn(!!t)), []);

  if (loggedIn === undefined) return null;
  if (!loggedIn) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 bg-canvas px-4">
        <img src="/logo.svg" alt="" className="h-28 w-28" />
        <h1 className="text-2xl font-semibold tracking-[0.2em]">OSIRIS</h1>
        <button
          onClick={() => login().catch((e: Error) => setLoginError(`Přihlášení selhalo: ${e.message}`))}
          disabled={!!configError}
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

type Page = "knowledge" | "skills" | "memory" | "mcp" | "secrets";

const PAGES: { page: Page; label: string; enabled: (f: TenantFeatures) => boolean }[] = [
  { page: "knowledge", label: "Znalostní báze", enabled: (f) => f.knowledge },
  { page: "skills", label: "Dovednosti", enabled: (f) => f.skills },
  { page: "memory", label: "Paměť", enabled: (f) => f.memory },
  { page: "mcp", label: "Nástroje (MCP)", enabled: (f) => f.mcp },
  { page: "secrets", label: "Klíče a hesla", enabled: (f) => f.http || f.mcp },
];

const LAST_TENANT = "osiris.tenant";
const remembered = () => {
  try {
    return localStorage.getItem(LAST_TENANT);
  } catch {
    return null;
  }
};

function Workspace() {
  const [me, setMe] = useState<MeResponse>();
  const [tenant, setTenantInfo] = useState<TenantInfo>();
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [view, setView] = useState<View>({ kind: "chat", threadId: null, session: 0 });
  const [error, setError] = useState<string>();

  const refreshThreads = useCallback(() => api.threads().then(setThreads, (e: Error) => setError(e.message)), []);

  const selectTenant = (id: string) => {
    setTenant(id);
    try {
      localStorage.setItem(LAST_TENANT, id);
    } catch {
      // Remembering the tenant is a convenience only.
    }
    setTenantInfo(undefined);
    api.tenant().then(setTenantInfo, (e: Error) => setError(e.message));
    setView((v) => ({ kind: "chat", threadId: null, session: (v.kind === "chat" ? v.session : 0) + 1 }));
    void refreshThreads();
  };

  /** Loads who the user is and keeps the current tenant if it's still theirs (it may have just been removed). */
  const loadMe = (current?: string) =>
    api.me().then((m) => {
      setMe(m);
      const ids = m.tenants.map((t) => t.id);
      const pick = [current, remembered()].find((id) => id && ids.includes(id)) ?? ids[0];
      if (!pick) {
        // A system admin with no tenant yet starts in the tenant administration.
        setTenantInfo(undefined);
        setView({ kind: "tenants" });
      } else if (pick !== current) selectTenant(pick);
    }, (e: Error) => setError(e.message));

  useEffect(() => void loadMe(), []);

  const open = (threadId: string | null) =>
    setView((v) => ({ kind: "chat", threadId, session: (v.kind === "chat" ? v.session : 0) + 1 }));

  const remove = async (id: string) => {
    await api.deleteThread(id);
    if (view.kind === "chat" && view.threadId === id) open(null);
    await refreshThreads();
  };

  if (error) return <p className="notice notice-error m-6 px-3 py-2">{error}</p>;
  if (!me) return null;
  const isAdmin = tenant?.role === "admin";
  const pages = tenant ? PAGES.filter((p) => p.enabled(tenant.features)) : [];
  const navButton = (target: View, label: string, active: boolean) => (
    <button key={label} onClick={() => setView(target)} data-active={active} className="list-row block w-full px-2 py-1.5 text-left">
      {label}
    </button>
  );
  const pageNav = (scope: Scope) =>
    pages.map((p) =>
      navButton({ kind: "settings", page: p.page, scope }, p.label, view.kind === "settings" && view.page === p.page && view.scope === scope),
    );

  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-64 shrink-0 flex-col border-r border-line bg-sidebar text-sm">
          <div className="flex items-center gap-2 px-3 pt-3">
            <img src="/logo.svg" alt="" className="h-8 w-8" />
            <span className="font-semibold tracking-[0.2em]">OSIRIS</span>
          </div>
          {(me.tenants.length > 1 || me.systemAdmin) && me.tenants.length > 0 && (
            <label className="mx-3 mt-3 block">
              <span className="section-header block pb-1">Tenant</span>
              <select value={tenant?.id ?? ""} onChange={(e) => selectTenant(e.target.value)} className="field w-full py-1">
                {me.tenants.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {tenant && (
            <>
              <button onClick={() => open(null)} className="btn-primary m-3">
                + Nový chat
              </button>
              <h2 className="section-header px-4 pb-1">Konverzace</h2>
              <nav className="flex-1 overflow-y-auto px-2">
                {threads.map((t) => (
                  <div
                    key={t.id}
                    data-active={view.kind === "chat" && view.threadId === t.id}
                    className="list-row group flex items-center px-2"
                  >
                    <button onClick={() => open(t.id)} className="flex-1 truncate py-1.5 text-left">
                      {t.channel === "whatsapp" && <span className="mr-1 text-fg-muted">WA</span>}
                      {t.title ?? "Nový chat"}
                    </button>
                    <button
                      onClick={() => remove(t.id)}
                      className="hidden px-1 text-fg-muted hover:text-error group-hover:block"
                      aria-label="Smazat"
                    >
                      ×
                    </button>
                  </div>
                ))}
                {!threads.length && <p className="px-2 py-1.5 text-fg-muted">Zatím žádné.</p>}
              </nav>
            </>
          )}
          <div className={`overflow-y-auto border-t border-line p-2 ${tenant ? "max-h-[55%]" : "mt-3 flex-1"}`}>
            {tenant && (
              <>
                <h2 className="section-header px-2 pb-1 pt-1">Moje nastavení</h2>
                {navButton({ kind: "profile" }, "Můj profil", view.kind === "profile")}
                {pageNav("personal")}
                {pages.length > 0 && (
                  <>
                    <h2 className="section-header px-2 pb-1 pt-3">Nastavení tenanta</h2>
                    {pageNav("tenant")}
                  </>
                )}
              </>
            )}
            {me.systemAdmin && (
              <>
                <h2 className="section-header px-2 pb-1 pt-3">Správa</h2>
                {navButton({ kind: "tenants" }, "Tenanti", view.kind === "tenants")}
              </>
            )}
          </div>
        </aside>
        <main className="h-full min-w-0 flex-1 bg-canvas">
          {view.kind === "tenants" ? (
            <Tenants
              onChanged={() => {
                void loadMe(tenant?.id);
                // The current tenant's name or features may have changed.
                if (tenant) api.tenant().then(setTenantInfo, () => {});
              }}
            />
          ) : !tenant ? null : view.kind === "settings" ? (
            <SettingsPage key={`${tenant.id}:${view.page}:${view.scope}`} page={view.page} scope={view.scope} canEdit={view.scope === "personal" || isAdmin} />
          ) : view.kind === "profile" ? (
            <Profile key={tenant.id} me={me} />
          ) : (
            <ChatPane
              key={`${tenant.id}:${view.session}`}
              threadId={view.threadId}
              onThreadCreated={(id) => setView((v) => (v.kind === "chat" ? { ...v, threadId: id } : v))}
              onRunFinished={refreshThreads}
            />
          )}
        </main>
      </div>
      {/* The OSIRIS signature: a solid accent status bar. */}
      <footer className="flex h-[26px] shrink-0 items-center justify-between bg-statusbar px-2.5 text-[11.5px] font-medium text-on-statusbar">
        <span className="truncate">
          {tenant ? `${tenant.name} · ${isAdmin ? "správce" : "člen"}` : "bez tenanta"}
          {me.systemAdmin && " · osiris-admin"}
        </span>
        <span className="flex items-center gap-3">
          <span className="truncate">{me.user.email ?? me.user.name}</span>
          <button onClick={logout} className="hover:underline">
            Odhlásit
          </button>
        </span>
      </footer>
    </div>
  );
}

function SettingsPage({ page, ...props }: { page: Page } & ScopedProps) {
  switch (page) {
    case "knowledge":
      return <Knowledge {...props} />;
    case "skills":
      return <Skills {...props} />;
    case "memory":
      return <Memories {...props} />;
    case "mcp":
      return <McpServers {...props} />;
    case "secrets":
      return <Secrets {...props} />;
  }
}
