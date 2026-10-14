import type { MeResponse, ThreadSummary } from "@osiris/shared";
import { useCallback, useEffect, useState } from "react";
import { api, setTenant } from "./api.ts";
import { configError, getAccessToken, login, logout } from "./auth.ts";
import { ChatPane } from "./chat/ChatPane.tsx";
import { Knowledge } from "./Knowledge.tsx";
import { McpServers } from "./McpServers.tsx";
import { Memories } from "./Memories.tsx";
import { Profile } from "./Profile.tsx";
import { Skills } from "./Skills.tsx";

type View = { kind: "chat"; threadId: string | null; session: number } | { kind: SettingsView };
type SettingsView = "knowledge" | "skills" | "memory" | "mcp" | "profile";

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

function Workspace() {
  const [me, setMe] = useState<MeResponse>();
  const [tenantId, setTenantId] = useState<string>();
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [view, setView] = useState<View>({ kind: "chat", threadId: null, session: 0 });
  const [error, setError] = useState<string>();

  useEffect(() => {
    api.me().then((m) => {
      setMe(m);
      selectTenant(m.tenants[0]!.id);
    }, (e: Error) => setError(e.message));
  }, []);

  const refreshThreads = useCallback(() => api.threads().then(setThreads, (e: Error) => setError(e.message)), []);

  const selectTenant = (id: string) => {
    setTenant(id);
    setTenantId(id);
    setView((v) => ({ kind: "chat", threadId: null, session: (v.kind === "chat" ? v.session : 0) + 1 }));
    void refreshThreads();
  };

  const open = (threadId: string | null) =>
    setView((v) => ({ kind: "chat", threadId, session: (v.kind === "chat" ? v.session : 0) + 1 }));

  const remove = async (id: string) => {
    await api.deleteThread(id);
    if (view.kind === "chat" && view.threadId === id) open(null);
    await refreshThreads();
  };

  if (error) return <p className="notice notice-error m-6 px-3 py-2">{error}</p>;
  if (!me || !tenantId) return null;
  const tenant = me.tenants.find((t) => t.id === tenantId);
  const isAdmin = tenant?.role === "admin";
  const navItem = (kind: SettingsView, label: string) => (
    <button
      onClick={() => setView({ kind })}
      data-active={view.kind === kind}
      className="list-row block w-full px-2 py-1.5 text-left"
    >
      {label}
    </button>
  );

  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-64 shrink-0 flex-col border-r border-line bg-sidebar text-sm">
          <div className="flex items-center gap-2 px-3 pt-3">
            <img src="/logo.svg" alt="" className="h-8 w-8" />
            <span className="font-semibold tracking-[0.2em]">OSIRIS</span>
          </div>
          {me.tenants.length > 1 && (
            <select value={tenantId} onChange={(e) => selectTenant(e.target.value)} className="field mx-3 mt-3 w-auto py-1">
              {me.tenants.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          )}
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
          <div className="border-t border-line p-2">
            <h2 className="section-header px-2 pb-1 pt-1">Nastavení</h2>
            {navItem("knowledge", "Znalostní báze")}
            {navItem("skills", "Dovednosti")}
            {navItem("memory", "Paměť")}
            {navItem("mcp", "Nástroje (MCP)")}
            {navItem("profile", "Můj profil")}
          </div>
        </aside>
        <main className="h-full min-w-0 flex-1 bg-canvas">
          {view.kind === "knowledge" ? (
            <Knowledge key={tenantId} isAdmin={isAdmin} />
          ) : view.kind === "skills" ? (
            <Skills key={tenantId} isAdmin={isAdmin} />
          ) : view.kind === "mcp" ? (
            <McpServers key={tenantId} isAdmin={isAdmin} />
          ) : view.kind === "profile" ? (
            <Profile key={tenantId} me={me} />
          ) : view.kind !== "chat" ? (
            <Memories key={tenantId} isAdmin={isAdmin} />
          ) : (
            <ChatPane
              key={`${tenantId}:${view.session}`}
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
          {tenant?.name} · {isAdmin ? "správce" : "člen"}
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
