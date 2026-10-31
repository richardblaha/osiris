/**
 * The layout of the windows over the twin, as plain data: each window (a group) holds one or more panels as tabs, sits
 * at a rectangle in fractions of the area (so it follows the window's size), may be maximized, and stacks by `z`.
 * Every panel is in exactly one group; a closed panel is in `hidden` until it is shown again. The layout is the
 * user's: kept in their preferences on the server and in this browser.
 */

/** The panels over the twin: the selection's properties, logs, metrics and traces, and the conversation with Osiris. */
export type PanelId = "properties" | "logs" | "metrics" | "traces" | "chat";
export const PANELS: readonly PanelId[] = ["properties", "logs", "metrics", "traces", "chat"];

/** A rectangle in fractions of the area: 0..1 from its top left corner. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Where a window snaps to: a half, a quarter, or the whole area. */
export type Snap = "left" | "right" | "top" | "bottom" | "tl" | "tr" | "bl" | "br" | "max";

export interface WindowGroup {
  id: string;
  /** Its panels, in tab order. */
  tabs: PanelId[];
  /** The tab shown. */
  active: PanelId;
  rect: Rect;
  /** Over the whole area; `rect` is where it goes back to. */
  maximized?: boolean;
  /** Stacking: higher is in front. */
  z: number;
}

export interface WindowLayout {
  version: 1;
  groups: WindowGroup[];
  /** Panels the user closed: they show again once the user asks (the display menu). */
  hidden: PanelId[];
}

/** Where each panel goes by default: the selection's four around the edges, the conversation at the bottom middle. */
const HOME: Record<PanelId, Rect> = {
  properties: { x: 0, y: 0, w: 0.26, h: 0.49 },
  logs: { x: 0.74, y: 0, w: 0.26, h: 0.49 },
  metrics: { x: 0.74, y: 0.51, w: 0.26, h: 0.49 },
  traces: { x: 0, y: 0.51, w: 0.26, h: 0.49 },
  chat: { x: 0.28, y: 0.52, w: 0.44, h: 0.48 },
};

export const defaultLayout = (): WindowLayout => ({
  version: 1,
  groups: PANELS.map((p, i) => ({ id: p, tabs: [p], active: p, rect: { ...HOME[p] }, z: i + 1 })),
  hidden: [],
});

/** The gap kept between windows that share the area (a fraction of it). */
const GAP = 0.01;

/** A snap's rectangle. */
export function snapRect(snap: Snap): Rect {
  const half = 0.5 - GAP / 2;
  switch (snap) {
    case "left":
      return { x: 0, y: 0, w: half, h: 1 };
    case "right":
      return { x: 1 - half, y: 0, w: half, h: 1 };
    case "top":
      return { x: 0, y: 0, w: 1, h: half };
    case "bottom":
      return { x: 0, y: 1 - half, w: 1, h: half };
    case "tl":
      return { x: 0, y: 0, w: half, h: half };
    case "tr":
      return { x: 1 - half, y: 0, w: half, h: half };
    case "bl":
      return { x: 0, y: 1 - half, w: half, h: half };
    case "br":
      return { x: 1 - half, y: 1 - half, w: half, h: half };
    case "max":
      return { x: 0, y: 0, w: 1, h: 1 };
  }
}

/**
 * The snap a pointer at (x, y) px in an area of `w`×`h` px asks for: near a corner its quarter, near the left, right or
 * bottom edge that half, near the top edge the whole area (maximized); elsewhere none.
 */
export function snapAt(x: number, y: number, w: number, h: number, edge = 28): Snap | undefined {
  const left = x <= edge;
  const right = x >= w - edge;
  const top = y <= edge;
  const bottom = y >= h - edge;
  // A corner reaches a little farther along each edge, so it is easy to hit.
  const near = edge * 4;
  const [zl, zr, zt, zb] = [x <= near, x >= w - near, y <= near, y >= h - near];
  if ((top && zl) || (left && zt)) return "tl";
  if ((top && zr) || (right && zt)) return "tr";
  if ((bottom && zl) || (left && zb)) return "bl";
  if ((bottom && zr) || (right && zb)) return "br";
  if (top) return "max";
  if (left) return "left";
  if (right) return "right";
  if (bottom) return "bottom";
  return undefined;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
/** A rectangle kept inside the area and at least `minW`×`minH` (fractions). */
export function clampRect(r: Rect, minW = 0.12, minH = 0.12): Rect {
  const w = clamp(r.w, Math.min(minW, 1), 1);
  const h = clamp(r.h, Math.min(minH, 1), 1);
  return { x: clamp(r.x, 0, 1 - w), y: clamp(r.y, 0, 1 - h), w, h };
}

const groupOf = (l: WindowLayout, tab: PanelId) => l.groups.find((g) => g.tabs.includes(tab));
const top = (l: WindowLayout) => Math.max(0, ...l.groups.map((g) => g.z)) + 1;
const fresh = (l: WindowLayout, base: string) => {
  let id = base;
  for (let i = 2; l.groups.some((g) => g.id === id); i++) id = `${base}-${i}`;
  return id;
};
const update = (l: WindowLayout, id: string, change: (g: WindowGroup) => WindowGroup): WindowLayout => ({ ...l, groups: l.groups.map((g) => (g.id === id ? change(g) : g)) });
/** Drops groups left without tabs. */
const tidy = (l: WindowLayout): WindowLayout => ({ ...l, groups: l.groups.filter((g) => g.tabs.length) });

/** Brings a group to the front. */
export const focusGroup = (l: WindowLayout, id: string): WindowLayout => (l.groups.find((g) => g.id === id)?.z === top(l) - 1 ? l : update(l, id, (g) => ({ ...g, z: top(l) })));

/** Moves or resizes a group (no longer maximized). */
export const placeGroup = (l: WindowLayout, id: string, rect: Rect): WindowLayout => update(l, id, (g) => ({ ...g, rect: clampRect(rect), maximized: false }));

/** Snaps a group: to a half or quarter, or maximized (keeping where it goes back to). */
export const snapGroup = (l: WindowLayout, id: string, snap: Snap): WindowLayout =>
  update(l, id, (g) => (snap === "max" ? { ...g, maximized: true, z: top(l) } : { ...g, rect: snapRect(snap), maximized: false, z: top(l) }));

export const toggleMaximized = (l: WindowLayout, id: string): WindowLayout => update(l, id, (g) => ({ ...g, maximized: !g.maximized, z: top(l) }));

export const activate = (l: WindowLayout, tab: PanelId): WindowLayout => {
  const g = groupOf(l, tab);
  return g ? update(l, g.id, (x) => ({ ...x, active: tab, z: top(l) })) : l;
};

/**
 * Merges into the group `into`: one tab of another group (`tab`), or all of the group `from`'s. The merged tab (or
 * the source's active one) is shown.
 */
export function mergeInto(l: WindowLayout, into: string, from: string, tab?: PanelId): WindowLayout {
  const source = l.groups.find((g) => g.id === from);
  const target = l.groups.find((g) => g.id === into);
  if (!source || !target || source === target) return l;
  const moving = tab ? (source.tabs.includes(tab) ? [tab] : []) : source.tabs;
  if (!moving.length) return l;
  const z = top(l);
  return tidy({
    ...l,
    groups: l.groups.map((g) => {
      if (g.id === into) return { ...g, tabs: [...g.tabs, ...moving], active: tab ?? source.active, z };
      if (g.id === from) {
        const tabs = g.tabs.filter((t) => !moving.includes(t));
        return { ...g, tabs, active: tabs.includes(g.active) ? g.active : (tabs[0] ?? g.active) };
      }
      return g;
    }),
  });
}

/** Takes a tab out of its group into a window of its own at `rect`. */
export function detach(l: WindowLayout, tab: PanelId, rect: Rect): { layout: WindowLayout; id: string } {
  const g = groupOf(l, tab);
  if (!g) return { layout: l, id: "" };
  if (g.tabs.length === 1) return { layout: placeGroup(focusGroup(l, g.id), g.id, rect), id: g.id };
  const id = fresh(l, tab);
  const z = top(l);
  const rest = g.tabs.filter((t) => t !== tab);
  const layout = {
    ...l,
    groups: [...l.groups.map((x) => (x.id === g.id ? { ...x, tabs: rest, active: x.active === tab ? rest[0]! : x.active } : x)), { id, tabs: [tab], active: tab, rect: clampRect(rect), z }],
  };
  return { layout, id };
}

/** Closes a panel: it leaves its group (an empty group goes) until it is shown again. */
export const closePanel = (l: WindowLayout, tab: PanelId): WindowLayout =>
  tidy({
    ...l,
    hidden: l.hidden.includes(tab) ? l.hidden : [...l.hidden, tab],
    groups: l.groups.map((g) => {
      if (!g.tabs.includes(tab)) return g;
      const tabs = g.tabs.filter((t) => t !== tab);
      return { ...g, tabs, active: g.active === tab ? (tabs[0] ?? tab) : g.active };
    }),
  });

/** Shows a closed panel again, in a window of its own at its default place, in front. */
export function showPanel(l: WindowLayout, tab: PanelId): WindowLayout {
  if (groupOf(l, tab)) return { ...activate(l, tab), hidden: l.hidden.filter((t) => t !== tab) };
  return { ...l, hidden: l.hidden.filter((t) => t !== tab), groups: [...l.groups, { id: fresh(l, tab), tabs: [tab], active: tab, rect: { ...HOME[tab] }, z: top(l) }] };
}

/** The groups to draw: those with an available panel, their tabs only the available ones (the active one among them). */
export function visibleGroups(l: WindowLayout, available: ReadonlySet<PanelId>): WindowGroup[] {
  return l.groups
    .map((g) => {
      const tabs = g.tabs.filter((t) => available.has(t) && !l.hidden.includes(t));
      return { ...g, tabs, active: tabs.includes(g.active) ? g.active : tabs[0]! };
    })
    .filter((g) => g.tabs.length);
}

const isRect = (r: unknown): r is Rect =>
  !!r && typeof r === "object" && ["x", "y", "w", "h"].every((k) => typeof (r as Record<string, unknown>)[k] === "number" && Number.isFinite((r as Record<string, number>)[k]));

/**
 * A stored layout made safe: unknown panels and malformed groups dropped, each panel in one group only, the missing
 * ones in a window of their own at their default place, rectangles inside the area. Anything unreadable: the default.
 */
export function normalizeLayout(raw: unknown): WindowLayout {
  if (!raw || typeof raw !== "object" || (raw as { version?: unknown }).version !== 1 || !Array.isArray((raw as { groups?: unknown }).groups)) return defaultLayout();
  const seen = new Set<PanelId>();
  const groups: WindowGroup[] = [];
  for (const g of (raw as { groups: unknown[] }).groups) {
    if (!g || typeof g !== "object") continue;
    const x = g as Partial<WindowGroup>;
    if (!isRect(x.rect) || !Array.isArray(x.tabs)) continue;
    const tabs: PanelId[] = [];
    for (const t of x.tabs) if (PANELS.includes(t as PanelId) && !seen.has(t as PanelId)) (tabs.push(t as PanelId), seen.add(t as PanelId));
    if (!tabs.length) continue;
    const id = typeof x.id === "string" && x.id && !groups.some((o) => o.id === x.id) ? x.id.slice(0, 40) : `${tabs[0]}-${groups.length}`;
    groups.push({ id, tabs, active: tabs.includes(x.active as PanelId) ? (x.active as PanelId) : tabs[0]!, rect: clampRect(x.rect), maximized: x.maximized === true, z: typeof x.z === "number" && Number.isFinite(x.z) ? x.z : groups.length + 1 });
  }
  const layout: WindowLayout = { version: 1, groups, hidden: [] };
  const hidden = Array.isArray((raw as { hidden?: unknown }).hidden) ? ((raw as { hidden: unknown[] }).hidden.filter((t) => PANELS.includes(t as PanelId)) as PanelId[]) : [];
  let out = layout;
  for (const p of PANELS) if (!seen.has(p)) out = showPanel(out, p);
  // Restack 1..n, keeping the order.
  const order = [...out.groups].sort((a, b) => a.z - b.z).map((g) => g.id);
  return { ...out, hidden: [...new Set(hidden)], groups: out.groups.map((g) => ({ ...g, z: order.indexOf(g.id) + 1 })) };
}

/**
 * One step of the agent's window work (`twin_view`'s `window` action) on a layout: show, close, bring forward,
 * maximize, restore, snap, join another panel's window, take a tab out. A panel that isn't anywhere is shown first.
 */
export function windowStep(l: WindowLayout, step: { op: "show" | "close" | "focus" | "maximize" | "restore" | "snap" | "merge" | "detach"; panel: PanelId; snap?: Snap; with?: PanelId }): WindowLayout {
  if (step.op === "close") return closePanel(l, step.panel);
  let out = showPanel(l, step.panel);
  const g = groupOf(out, step.panel)!;
  switch (step.op) {
    case "maximize":
      return g.maximized ? out : toggleMaximized(out, g.id);
    case "restore":
      return g.maximized ? toggleMaximized(out, g.id) : out;
    case "snap":
      return step.snap ? snapGroup(out, g.id, step.snap) : out;
    case "merge": {
      if (!step.with || step.with === step.panel) return out;
      out = showPanel(out, step.with);
      const into = groupOf(out, step.with)!;
      return into.id === g.id ? activate(out, step.panel) : mergeInto(out, into.id, g.id, step.panel);
    }
    case "detach":
      return g.tabs.length > 1 ? detach(out, step.panel, { ...g.rect, x: Math.min(0.97 - g.rect.w, g.rect.x + 0.03), y: Math.min(0.97 - g.rect.h, g.rect.y + 0.03) }).layout : out;
    default:
      return out;
  }
}
