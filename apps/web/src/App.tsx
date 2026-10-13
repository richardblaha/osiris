import type { MeResponse, ThreadSummary } from "@osiris/shared";
import { useCallback, useEffect, useState } from "react";
import { api, setTenant } from "./api.ts";
import { configError, getAccessToken, login, logout } from "./auth.ts";
import { ChatPane } from "./chat/ChatPane.tsx";
import { Knowledge } from "./Knowledge.tsx";
import { Memories } from "./Memories.tsx";
import { Skills } from "./Skills.tsx";

type View = { kind: "chat"; threadId: string | null; session: number } | { kind: "knowledge" | "skills" | "memory" };

export function App() {
  const [loggedIn, setLoggedIn] = useState<boolean>();
  const [loginError, setLoginError] = useState(configError);
  useEffect(() => void getAccessToken().then((t) => setLoggedIn(!!t)), []);

  if (loggedIn === undefined) return null;
  if (!loggedIn) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 px-4">
        <img src="/logo.svg" alt="" className="h-28 w-28" />
        <h1 className="text-2xl font-semibold tracking-wide">Osiris</h1>
        <button
          onClick={() => login().catch((e: Error) => setLoginError(`Přihlášení selhalo: ${e.message}`))}
          disabled={!!configError}
          className="rounded-xl bg-neutral-900 px-6 py-3 text-white disabled:opacity-40"
        >
          Přihlásit se
        </button>
        {loginError && <p className="max-w-md text-center text-sm text-red-600">{loginError}</p>}
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

  if (error) return <p className="p-6 text-red-600">{error}</p>;
  if (!me || !tenantId) return null;
  const isAdmin = me.tenants.find((t) => t.id === tenantId)?.role === "admin";

  return (
    <div className="flex h-full">
      <aside className="flex w-64 shrink-0 flex-col border-r border-neutral-200 bg-neutral-50">
        <div className="flex items-center gap-2 px-3 pt-3">
          <img src="/logo.svg" alt="" className="h-8 w-8" />
          <span className="font-semibold tracking-wide">Osiris</span>
        </div>
        {me.tenants.length > 1 && (
          <select
            value={tenantId}
            onChange={(e) => selectTenant(e.target.value)}
            className="m-3 rounded-lg border border-neutral-300 bg-white px-2 py-1"
          >
            {me.tenants.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        )}
        <button onClick={() => open(null)} className="m-3 rounded-lg bg-neutral-900 px-3 py-2 text-white">
          + Nový chat
        </button>
        <nav className="flex-1 overflow-y-auto px-2">
          {threads.map((t) => (
            <div
              key={t.id}
              className={`group flex items-center rounded-lg px-2 ${view.kind === "chat" && view.threadId === t.id ? "bg-neutral-200" : "hover:bg-neutral-100"}`}
            >
              <button onClick={() => open(t.id)} className="flex-1 truncate py-2 text-left text-sm">
                {t.title ?? "Nový chat"}
              </button>
              <button onClick={() => remove(t.id)} className="hidden text-neutral-400 group-hover:block" aria-label="Smazat">
                ×
              </button>
            </div>
          ))}
        </nav>
        <div className="space-y-1 border-t border-neutral-200 p-3 text-sm">
          <button onClick={() => setView({ kind: "knowledge" })} className="block">
            Znalostní báze
          </button>
          <button onClick={() => setView({ kind: "skills" })} className="block">
            Dovednosti
          </button>
          <button onClick={() => setView({ kind: "memory" })} className="block">
            Paměť
          </button>
          <button onClick={logout} className="block text-neutral-500">
            Odhlásit ({me.user.email ?? me.user.name})
          </button>
        </div>
      </aside>
      <main className="h-full flex-1">
        {view.kind === "knowledge" ? (
          <Knowledge key={tenantId} canEdit={isAdmin} />
        ) : view.kind === "skills" ? (
          <Skills key={tenantId} canEdit={isAdmin} />
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
  );
}
