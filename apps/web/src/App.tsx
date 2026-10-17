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
  ThreadSummary,
} from "@osiris/shared";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api, setTenant } from "./api.ts";
import { configError, getAccessToken, login, logout } from "./auth.ts";
import { ChatPane } from "./chat/ChatPane.tsx";
import { Files } from "./Files.tsx";
import { Schedules } from "./Schedules.tsx";
import { Sites } from "./Sites.tsx";
import { documentKey, KnowledgeDetail } from "./Knowledge.tsx";
import { mcpKey, McpServerDetail, McpStatus } from "./McpServers.tsx";
import { MemoryDetail, memoryKey } from "./Memories.tsx";
import { Avatar, Profile } from "./Profile.tsx";
import { ScopeBadge } from "./Scope.tsx";
import { SecretDetail, secretKey } from "./Secrets.tsx";
import { loadSkills, SkillDetail, skillKey } from "./Skills.tsx";
import { roleLabel, TenantInfo } from "./TenantInfo.tsx";
import { NewTenant, TenantPanel } from "./Tenants.tsx";

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

/** Sidebar sections whose records open as a detail form; `tenants` is the system admin's tenant administration. */
type Section = "knowledge" | "skills" | "memory" | "mcp" | "secrets" | "tenants";

type View =
  | { kind: "chat"; threadId: string | null; session: number }
  /** A record of a section by its key, or `null` for the form of a new one. */
  | { kind: "item"; section: Section; id: string | null }
  | { kind: "profile" }
  | { kind: "tenant" }
  | { kind: "files" }
  | { kind: "schedules" }
  | { kind: "sites" };

interface Lists {
  knowledge: DocumentSummary[];
  skills: SkillSummary[];
  memory: Memory[];
  mcp: McpServer[];
  secrets: SecretSummary[];
  tenants: TenantSummary[];
}

const EMPTY: Lists = { knowledge: [], skills: [], memory: [], mcp: [], secrets: [], tenants: [] };

const LOADERS: { [S in Section]: () => Promise<Lists[S]> } = {
  knowledge: api.documents,
  skills: loadSkills,
  memory: api.memories,
  mcp: api.mcpServers,
  secrets: api.secrets,
  tenants: api.admin.tenants,
};

const SECTIONS: { id: Exclude<Section, "tenants">; label: string; add: string; enabled: (f: TenantFeatures) => boolean }[] = [
  { id: "knowledge", label: "Znalostní báze", add: "Přidat dokument", enabled: (f) => f.knowledge },
  { id: "skills", label: "Dovednosti", add: "Přidat dovednost", enabled: (f) => f.skills },
  { id: "memory", label: "Paměť", add: "Přidat záznam", enabled: (f) => f.memory },
  { id: "mcp", label: "Nástroje (MCP)", add: "Přidat server", enabled: (f) => f.mcp },
  { id: "secrets", label: "Klíče a hesla", add: "Přidat klíč", enabled: (f) => f.http || f.mcp },
];

interface Row {
  key: string;
  label: string;
  badge?: ReactNode;
}

/** Personal records are the default, so only tenant-wide and bundled ones get a badge in the sidebar. */
const scopeBadge = (scope: Scope | "bundled") => (scope === "personal" ? undefined : <ScopeBadge scope={scope} />);

function rows(section: Section, lists: Lists): Row[] {
  switch (section) {
    case "knowledge":
      return lists.knowledge.map((d) => ({ key: documentKey(d), label: d.title, badge: scopeBadge(d.scope) }));
    case "skills":
      return lists.skills.map((s) => ({ key: skillKey(s), label: s.name, badge: scopeBadge(s.source) }));
    case "memory":
      return lists.memory.map((m) => ({ key: memoryKey(m), label: m.content, badge: scopeBadge(m.scope) }));
    case "mcp":
      return lists.mcp.map((s) => ({
        key: mcpKey(s),
        label: s.name,
        badge: (
          <>
            {scopeBadge(s.scope)} <McpStatus server={s} />
          </>
        ),
      }));
    case "secrets":
      return lists.secrets.map((s) => ({ key: secretKey(s), label: s.name, badge: scopeBadge(s.scope) }));
    default:
      return lists.tenants.map((t) => ({ key: t.id, label: t.name }));
  }
}

const LAST_TENANT = "osiris.tenant";
const OPEN_SECTIONS = "osiris.sections";

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
  const [view, setView] = useState<View>({ kind: "chat", threadId: null, session: 0 });
  const [open, setOpen] = useState<Record<string, boolean>>(() => stored(OPEN_SECTIONS, { threads: true }));
  const [error, setError] = useState<string>();

  const refreshThreads = useCallback(() => api.threads().then(setThreads, (e: Error) => setError(e.message)), []);
  const refresh = (section: Section) =>
    LOADERS[section]().then((items) => setLists((l) => ({ ...l, [section]: items })), (e: Error) => setError(e.message));

  const toggle = (section: string, value?: boolean) =>
    setOpen((o) => {
      const next = { ...o, [section]: value ?? !o[section] };
      store(OPEN_SECTIONS, next);
      return next;
    });

  const loadTenant = () =>
    api.tenant().then((t) => {
      setTenantInfo(t);
      for (const s of SECTIONS) if (s.enabled(t.features)) void refresh(s.id);
    }, (e: Error) => setError(e.message));

  const selectTenant = (id: string) => {
    setTenant(id);
    store(LAST_TENANT, id);
    setTenantInfo(undefined);
    setLists((l) => ({ ...EMPTY, tenants: l.tenants }));
    void loadTenant();
    setView((v) => ({ kind: "chat", threadId: null, session: (v.kind === "chat" ? v.session : 0) + 1 }));
    void refreshThreads();
  };

  /** Loads who the user is and keeps the current tenant if it's still theirs (it may have just been removed). */
  const loadMe = (current?: string) =>
    api.me().then((m) => {
      setMe(m);
      if (m.systemAdmin) void refresh("tenants");
      const ids = m.tenants.map((t) => t.id);
      const pick = [current, stored<string | null>(LAST_TENANT, null)].find((id) => id && ids.includes(id)) ?? ids[0];
      if (!pick) {
        // A system admin with no tenant yet starts with creating one.
        setTenantInfo(undefined);
        setView({ kind: "item", section: "tenants", id: null });
      } else if (pick !== current) selectTenant(pick);
    }, (e: Error) => setError(e.message));

  useEffect(() => void loadMe(), []);

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
  const select = (section: Section, id: string | null) => {
    if (id === null) toggle(section, true);
    setView({ kind: "item", section, id });
  };

  const sectionNav = (section: Section, label: string, add: string, empty: string) => (
    <SidebarSection key={section} title={label} count={lists[section].length} open={!!open[section]} onToggle={() => toggle(section)} onAdd={() => select(section, null)} addLabel={add}>
      {rows(section, lists).map((r) => (
        <button
          key={r.key}
          onClick={() => select(section, r.key)}
          data-active={view.kind === "item" && view.section === section && view.id === r.key}
          className="list-row flex w-full items-center gap-2 px-2 py-1.5 text-left"
        >
          <span className="min-w-0 flex-1 truncate">{r.label}</span>
          {r.badge && <span className="flex shrink-0 gap-1">{r.badge}</span>}
        </button>
      ))}
      {!lists[section].length && <p className="px-2 py-1.5 text-fg-muted">{empty}</p>}
    </SidebarSection>
  );

  return (
    <div className="flex h-full">
      <aside className="flex w-72 shrink-0 flex-col border-r border-line bg-sidebar text-sm">
        <div className="flex items-center gap-2 px-3 pt-3">
          <img src="/logo.svg" alt="" className="h-8 w-8" />
          <span className="font-semibold tracking-[0.2em]">OSIRIS</span>
        </div>
        {tenant && (
          <button onClick={() => openThread(null)} className="btn-primary mx-3 mt-3">
            + Nový chat
          </button>
        )}
        <nav className="mt-3 min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {tenant && (
            <SidebarSection title="Konverzace" count={threads.length} open={!!open.threads} onToggle={() => toggle("threads")}>
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
            </SidebarSection>
          )}
          {tenant?.features.files && (
            <NavLink active={view.kind === "files"} onClick={() => setView({ kind: "files" })} label="Soubory" icon="M2 4h4l1.5 1.5H14V13H2z" />
          )}
          {tenant?.features.scheduler && (
            <NavLink active={view.kind === "schedules"} onClick={() => setView({ kind: "schedules" })} label="Plánované úlohy" icon="M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2zm0 3v3.5l2.5 1.5" />
          )}
          {tenant?.features.sites && (
            <NavLink active={view.kind === "sites"} onClick={() => setView({ kind: "sites" })} label="Web" icon="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2z" />
          )}
          {sections.map((s) => sectionNav(s.id, s.label, s.add, "Zatím nic."))}
          {me.systemAdmin && sectionNav("tenants", "Tenanti", "Založit tenanta", "Zatím žádní.")}
        </nav>

        <div className="border-t border-line p-2">
          <button onClick={() => setView({ kind: "tenant" })} data-active={view.kind === "tenant"} className="list-row flex w-full items-center gap-3 px-2 py-2 text-left">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-sm bg-secondary-soft font-semibold text-secondary">
              {(tenant?.name ?? "?").slice(0, 1).toUpperCase()}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{tenant?.name ?? "Žádný tenant"}</span>
              <span className="block truncate text-xs text-fg-muted">
                {tenant ? roleLabel(tenant.role) : "vyber nebo založ tenanta"}
                {me.tenants.length > 1 && ` · ${me.tenants.length} ${me.tenants.length <= 4 ? "tenanti" : "tenantů"}`}
              </span>
            </span>
          </button>
          <button onClick={() => setView({ kind: "profile" })} data-active={view.kind === "profile"} className="list-row flex w-full items-center gap-3 px-2 py-2 text-left">
            <Avatar user={me.user} />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{me.user.name ?? me.user.email}</span>
              {me.user.name && me.user.email && <span className="block truncate text-xs text-fg-muted">{me.user.email}</span>}
            </span>
          </button>
        </div>
      </aside>

      <main className="h-full min-w-0 flex-1 bg-canvas">
        {view.kind === "item" && view.section === "tenants" ? (
          view.id ? (
            <TenantPanel
              key={view.id}
              id={view.id}
              onChanged={() => {
                void refresh("tenants");
                void loadMe(tenant?.id);
                // The current tenant's name or features may have changed.
                if (tenant) void loadTenant();
              }}
              onDeleted={() => {
                void refresh("tenants");
                void loadMe(tenant?.id);
                setView({ kind: "item", section: "tenants", id: null });
              }}
            />
          ) : (
            <NewTenant
              onCreated={(id) => {
                void refresh("tenants");
                void loadMe(tenant?.id);
                setView({ kind: "item", section: "tenants", id });
              }}
            />
          )
        ) : view.kind === "tenant" ? (
          <TenantInfo me={me} tenant={tenant} onSelect={selectTenant} />
        ) : view.kind === "profile" ? (
          <Profile key={tenant?.id} me={me} />
        ) : !tenant ? null : view.kind === "files" ? (
          tenant.features.files ? <Files key={tenant.id} isAdmin={isAdmin} /> : null
        ) : view.kind === "schedules" ? (
          tenant.features.scheduler ? <Schedules key={tenant.id} isAdmin={isAdmin} onOpenThread={(id) => (openThread(id), void refreshThreads())} /> : null
        ) : view.kind === "sites" ? (
          tenant.features.sites ? <Sites key={tenant.id} isAdmin={isAdmin} /> : null
        ) : view.kind === "item" ? (
          <Detail
            key={`${tenant.id}:${view.section}:${view.id ?? "new"}`}
            section={view.section}
            id={view.id}
            lists={lists}
            isAdmin={isAdmin}
            onSaved={(key) => void refresh(view.section).then(() => setView({ kind: "item", section: view.section, id: key }))}
            onDeleted={() => void refresh(view.section).then(() => setView({ kind: "item", section: view.section, id: null }))}
          />
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
  );
}

function NavLink({ active, onClick, label, icon }: { active: boolean; onClick: () => void; label: string; icon: string }) {
  return (
    <button onClick={onClick} data-active={active} className="section-header list-row mt-2 flex w-full items-center gap-1 px-2 py-1 text-left">
      <svg viewBox="0 0 16 16" className="h-3 w-3" aria-hidden="true">
        <path d={icon} fill="none" stroke="currentColor" strokeWidth="1.4" />
      </svg>
      {label}
    </button>
  );
}

function SidebarSection(props: {
  title: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  onAdd?: () => void;
  addLabel?: string;
  children: ReactNode;
}) {
  return (
    <section className="mt-2 first:mt-0">
      <div className="flex items-center">
        <button onClick={props.onToggle} aria-expanded={props.open} className="section-header flex flex-1 items-center gap-1 px-2 py-1 text-left">
          <svg viewBox="0 0 16 16" className={`h-3 w-3 transition-transform ${props.open ? "rotate-90" : ""}`} aria-hidden="true">
            <path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.8" />
          </svg>
          {props.title}
          {props.count > 0 && <span className="font-normal text-fg-muted">{props.count}</span>}
        </button>
        {props.onAdd && (
          <button onClick={props.onAdd} title={props.addLabel} aria-label={props.addLabel} className="list-row px-2 text-base leading-6 text-fg-secondary hover:text-primary">
            +
          </button>
        )}
      </div>
      {props.open && <div className="mt-0.5">{props.children}</div>}
    </section>
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
    default:
      // Tenants have their own panel, see Workspace.
      return null;
  }
}
