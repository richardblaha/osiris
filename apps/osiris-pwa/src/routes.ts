export const SETTINGS_PARTS = ["features", "quotas", "runtime", "personalization", "persona"] as const;
export type SettingsPart = (typeof SETTINGS_PARTS)[number];

/**
 * The workspace's views as URLs, so the browser's back and forward, reloads and links work:
 * `/p/<project>[/chat/<thread>|/<section>[/<id>|/new]|/files|...]`, `/profile` and `/system/<view>[/<id>]`.
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
  | { kind: "project" }
  /** The system admin's project administration, opening a project (or `null`: the form of a new one). */
  | { kind: "projects"; initial?: string | null }
  /** The system admin's user administration. */
  | { kind: "users" }
  | { kind: "settings"; part?: SettingsPart }
  /** The project's sites' web analytics. */
  | { kind: "analytics" }
  | { kind: "files" }
  | { kind: "schedules" }
  | { kind: "database" }
  /** The project's dashboards. */
  | { kind: "dashboard" }
  /** The system's dashboards (system admins). */
  | { kind: "sysdash" }
  | { kind: "sites" }
  | { kind: "guards" }
  | { kind: "public" };

/** Views of the active project without a record of their own. */
const PROJECT_PAGES = ["dashboard", "analytics", "files", "schedules", "database", "sites", "guards", "public", "users", "project"] as const;

const seg = encodeURIComponent;

/** The view's URL; `undefined` for a project's view while no project is open. */
export function toPath(view: View, project: string | undefined): string | undefined {
  switch (view.kind) {
    case "profile":
      return "/profile";
    case "settings":
      return `/system/settings${view.part ? `/${view.part}` : ""}`;
    case "sysdash":
      return "/system/dashboard";
    case "projects":
      return `/system/projects${view.initial === null ? "/new" : view.initial ? `/${seg(view.initial)}` : ""}`;
  }
  if (!project) return undefined;
  const base = `/p/${seg(project)}`;
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

/** The view (and its project) of a URL; `undefined` for one that isn't the workspace's. */
export function fromPath(path: string): { project?: string; view: View } | undefined {
  let parts: string[];
  try {
    parts = path.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    return undefined;
  }
  const [top, a, b, c] = parts;
  if (top === "profile" && !a) return { view: { kind: "profile" } };
  if (top === "system") {
    if (a === "settings" && !c && (!b || (SETTINGS_PARTS as readonly string[]).includes(b))) return { view: b ? { kind: "settings", part: b as SettingsPart } : { kind: "settings" } };
    if (a === "dashboard" && !b) return { view: { kind: "sysdash" } };
    if (a === "projects" && !c) return { view: { kind: "projects", initial: b === "new" ? null : b } };
    return undefined;
  }
  if (top !== "p" || !a) return undefined;
  const project = a;
  if (!b) return { project, view: { kind: "chat", threadId: null, session: 0 } };
  if (b === "chat" && c && parts.length === 4) return { project, view: { kind: "chat", threadId: c, session: 0 } };
  if ((PROJECT_PAGES as readonly string[]).includes(b) && !c) return { project, view: { kind: b as (typeof PROJECT_PAGES)[number] } };
  if ((SECTION_IDS as readonly string[]).includes(b) && parts.length <= 4) {
    const section = b as Section;
    if (!c) return { project, view: { kind: "list", section } };
    return { project, view: { kind: "item", section, id: c === "new" ? null : c } };
  }
  return undefined;
}

/** Where the user last was (localStorage, so the installed app reopens there); cleared on logout. */
export const LAST_PATH = "osiris.lastPath";
