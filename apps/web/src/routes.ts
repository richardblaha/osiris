/**
 * The workspace's views as URLs, so the browser's back and forward, reloads and links work:
 * `/t/<tenant>[/chat/<thread>|/<section>[/<id>|/new]|/files|...]`, `/profile` and `/system/<view>[/<id>]`.
 */

/** Sidebar sections whose records open as a detail form. */
export const SECTION_IDS = ["knowledge", "skills", "memory", "mcp", "secrets"] as const;
export type Section = (typeof SECTION_IDS)[number];

export type View =
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
  | { kind: "settings" }
  /** The cluster's telemetry (system admins); a trace open, or logs of one trace. */
  | { kind: "logs"; traceId?: string }
  | { kind: "metrics" }
  | { kind: "traces"; traceId?: string }
  | { kind: "files" }
  | { kind: "schedules" }
  | { kind: "sites" }
  | { kind: "guards" }
  | { kind: "public" };

/** Views of the active tenant without a record of their own. */
const TENANT_PAGES = ["files", "schedules", "sites", "guards", "public", "users", "tenant"] as const;

const seg = encodeURIComponent;

/** The view's URL; `undefined` for a tenant's view while no tenant is open. */
export function toPath(view: View, tenant: string | undefined): string | undefined {
  switch (view.kind) {
    case "profile":
      return "/profile";
    case "settings":
    case "metrics":
      return `/system/${view.kind}`;
    case "logs":
    case "traces":
      return `/system/${view.kind}${view.traceId ? `/${seg(view.traceId)}` : ""}`;
    case "tenants":
      return `/system/tenants${view.initial === null ? "/new" : view.initial ? `/${seg(view.initial)}` : ""}`;
  }
  if (!tenant) return undefined;
  const base = `/t/${seg(tenant)}`;
  switch (view.kind) {
    case "chat":
      return view.threadId ? `${base}/chat/${seg(view.threadId)}` : base;
    case "list":
      return `${base}/${view.section}`;
    case "item":
      return `${base}/${view.section}/${view.id === null ? "new" : seg(view.id)}`;
    default:
      return `${base}/${view.kind}`;
  }
}

/** The view (and its tenant) of a URL; `undefined` for one that isn't the workspace's. */
export function fromPath(path: string): { tenant?: string; view: View } | undefined {
  let parts: string[];
  try {
    parts = path.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    return undefined;
  }
  const [top, a, b, c] = parts;
  if (top === "profile" && !a) return { view: { kind: "profile" } };
  if (top === "system") {
    if ((a === "settings" || a === "metrics") && !b) return { view: { kind: a } };
    if ((a === "logs" || a === "traces") && !c) return { view: { kind: a, traceId: b } };
    if (a === "tenants" && !c) return { view: { kind: "tenants", initial: b === "new" ? null : b } };
    return undefined;
  }
  if (top !== "t" || !a) return undefined;
  const tenant = a;
  if (!b) return { tenant, view: { kind: "chat", threadId: null, session: 0 } };
  if (b === "chat" && c && parts.length === 4) return { tenant, view: { kind: "chat", threadId: c, session: 0 } };
  if ((TENANT_PAGES as readonly string[]).includes(b) && !c) return { tenant, view: { kind: b as (typeof TENANT_PAGES)[number] } };
  if ((SECTION_IDS as readonly string[]).includes(b) && parts.length <= 4) {
    const section = b as Section;
    if (!c) return { tenant, view: { kind: "list", section } };
    return { tenant, view: { kind: "item", section, id: c === "new" ? null : c } };
  }
  return undefined;
}

/** Where the user last was (localStorage, so the installed app reopens there); cleared on logout. */
export const LAST_PATH = "osiris.lastPath";
