import { t } from "i18next";
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from "react";
import type { MaterialIcon } from "@osiris/shared/material-icons.ts";
import { Icon } from "./Icon.tsx";
import { usePopupClose } from "./Telemetry.tsx";
import type { Point } from "./Twin3D.tsx";
import {
  activate,
  clampRect,
  closePanel,
  detach,
  focusGroup,
  GRID_AREAS,
  gridAreaAt,
  mergeInto,
  placeGroup,
  snapAt,
  snapGroup,
  snapRect,
  toggleMaximized,
  visibleGroups,
  type PanelId,
  type Rect,
  type Snap,
  type WindowGroup,
  type WindowLayout,
} from "./windowLayout.ts";

/** What a panel shows in its window: its tab's title (and a line under it), icon, buttons, body. */
export interface PanelView {
  title: string;
  heading?: string;
  icon: MaterialIcon;
  actions?: ReactNode;
  body: ReactNode;
  /** The body without padding (lists that run to the edges). */
  flush?: boolean;
  /** Joined by a line to the selected twin's box. */
  anchored?: boolean;
  /** Closing does this (the conversation closes) instead of hiding the panel. */
  onClose?: () => void;
}

/** The least size of a window, in px. */
const MIN = { w: 240, h: 140 };
/** Below this width the windows are one, with every panel a tab, over the lower part of the view. */
const NARROW = 720;
const RESIZE = ["n", "s", "e", "w", "ne", "nw", "se", "sw"] as const;
type Dir = (typeof RESIZE)[number];

type Drag =
  | { kind: "move"; id: string; tab?: PanelId; sx: number; sy: number; dx: number; dy: number; started: boolean }
  | { kind: "resize"; id: string; dir: Dir; sx: number; sy: number; start: { l: number; t: number; w: number; h: number } };

/**
 * The windows over the twin: each a group of panels as tabs, placed as the user's layout says. A window moves by its
 * header and docks in one of the area's 9 parts (the grid of 20 %, 60 %, 20 % columns and rows) when dropped on that
 * cell of the compass shown while dragging, or at an edge or corner (the top edge maximizes); a part that holds a
 * window takes it in as tabs. Dropped on another window's header it joins it as tabs, and a tab dragged out becomes a
 * window of its own. Windows resize by
 * their edges and corners, maximize (the button or a double click on the header) and come to the front when touched;
 * the menu in the header does the same without dragging. The selection's panels have a line to its box.
 */
export function Windows({
  layout,
  onLayout,
  panels,
  anchor,
}: {
  layout: WindowLayout;
  onLayout: (l: WindowLayout) => void;
  panels: Partial<Record<PanelId, PanelView>>;
  anchor: RefObject<(() => Point[] | null) | null>;
}) {
  const area = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  /** The layout while a window is dragged or resized; committed when the pointer lets go. */
  const [draft, setDraft] = useState<WindowLayout | null>(null);
  const [preview, setPreview] = useState<{ snap?: Snap; into?: string }>({});
  const [narrowTab, setNarrowTab] = useState<PanelId>();
  const drag = useRef<Drag | null>(null);
  const compass = useRef<HTMLDivElement>(null);
  const live = useRef(layout);
  live.current = draft ?? layout;
  const commit = useRef(onLayout);
  commit.current = onLayout;
  const windows = useRef(new Map<string, HTMLElement>());
  const headers = useRef(new Map<string, HTMLElement>());
  const lines = useRef(new Map<string, SVGPathElement>());
  /** A tab's click right after dragging it isn't a click. */
  const dragged = useRef(false);

  useLayoutEffect(() => {
    const el = area.current!;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const available = new Set(Object.keys(panels) as PanelId[]);
  const shown = draft ?? layout;
  const narrow = size.w > 0 && size.w < NARROW;
  const groups: WindowGroup[] = narrow ? narrowGroup(shown, available, narrowTab) : visibleGroups(shown, available);
  const front = Math.max(0, ...groups.map((g) => g.z));
  const visibleIds = useRef<string[]>([]);
  visibleIds.current = groups.map((g) => g.id);

  // The lines from the selection's windows to its box, every frame: from the window's edge nearest the box's nearest
  // corner, with a short knee out of the window.
  useEffect(() => {
    let frame = 0;
    const draw = () => {
      frame = requestAnimationFrame(draw);
      const box = area.current?.getBoundingClientRect();
      const corners = anchor.current?.() ?? null;
      for (const [id, path] of lines.current) {
        const el = windows.current.get(id);
        if (!box || !el || !corners?.length || el.dataset.max === "true") {
          path.style.display = "none";
          continue;
        }
        const r = el.getBoundingClientRect();
        const rect = { l: r.left - box.left, t: r.top - box.top, r: r.right - box.left, b: r.bottom - box.top };
        const mid = { x: (rect.l + rect.r) / 2, y: (rect.t + rect.b) / 2 };
        const target = corners.reduce((best, p) => (Math.hypot(p.x - mid.x, p.y - mid.y) < Math.hypot(best.x - mid.x, best.y - mid.y) ? p : best));
        const sx = Math.min(rect.r, Math.max(rect.l, target.x));
        const sy = Math.min(rect.b, Math.max(rect.t, target.y));
        if (sx > rect.l && sx < rect.r && sy > rect.t && sy < rect.b) {
          path.style.display = "none";
          continue;
        }
        path.style.display = "";
        const side = sx === rect.l || sx === rect.r;
        const knee = side ? { x: sx + (sx === rect.l ? -24 : 24), y: sy } : { x: sx, y: sy + (sy === rect.t ? -24 : 24) };
        path.setAttribute("d", `M${sx},${sy} L${knee.x},${knee.y} L${target.x},${target.y}`);
      }
    };
    draw();
    return () => cancelAnimationFrame(frame);
  }, [anchor]);

  /** The pointer's place in the area, px. */
  const local = (e: { clientX: number; clientY: number }) => {
    const b = area.current!.getBoundingClientRect();
    return { x: e.clientX - b.left, y: e.clientY - b.top };
  };
  const pxOf = (r: Rect) => ({ l: r.x * size.w, t: r.y * size.h, w: r.w * size.w, h: r.h * size.h });
  const fractionOf = (l: number, top: number, w: number, h: number): Rect => clampRect({ x: l / size.w, y: top / size.h, w: w / size.w, h: h / size.h }, MIN.w / size.w, MIN.h / size.h);

  // Dragging and resizing follow the pointer anywhere in the window, and end where it lets go.
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const d = drag.current;
      if (!d || !area.current) return;
      const p = local(e);
      let l = live.current;
      const g = l.groups.find((x) => x.id === d.id);
      if (!g) return;
      if (d.kind === "resize") {
        const dx = e.clientX - d.sx;
        const dy = e.clientY - d.sy;
        let { l: left, t: top, w, h } = d.start;
        if (d.dir.includes("e")) w = Math.max(MIN.w, w + dx);
        if (d.dir.includes("s")) h = Math.max(MIN.h, h + dy);
        if (d.dir.includes("w")) (left = Math.min(left + dx, left + w - MIN.w)), (w = Math.max(MIN.w, w - dx));
        if (d.dir.includes("n")) (top = Math.min(top + dy, top + h - MIN.h)), (h = Math.max(MIN.h, h - dy));
        setDraft(placeGroup(l, d.id, fractionOf(left, top, w, h)));
        return;
      }
      if (!d.started) {
        if (Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 5) return;
        d.started = true;
        dragged.current = true;
        const px = pxOf(g.rect);
        // A tab out of a window of several: a window of its own, under the pointer.
        if (d.tab && g.tabs.length > 1) {
          const out = detach(l, d.tab, fractionOf(p.x - Math.min(d.dx, px.w / 2), p.y - d.dy, px.w, px.h));
          l = out.layout;
          d.id = out.id;
          d.dx = Math.min(d.dx, px.w / 2);
        } else if (g.maximized) {
          // A maximized window let go of by dragging: back to its size, under the pointer.
          d.dx = px.w / 2;
          l = placeGroup(l, g.id, g.rect);
        }
      }
      const now = l.groups.find((x) => x.id === d.id)!;
      const px = pxOf(now.rect);
      l = placeGroup(l, d.id, fractionOf(p.x - d.dx, p.y - d.dy, px.w, px.h));
      // Over another window's header: join it; else over the compass: dock in its cell's part; else near an edge.
      let into: string | undefined;
      for (const id of visibleIds.current) {
        if (id === d.id) continue;
        const r = headers.current.get(id)?.getBoundingClientRect();
        if (r && e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) into = id;
      }
      const c = compass.current?.getBoundingClientRect();
      const onCompass = !!c && e.clientX >= c.left && e.clientX <= c.right && e.clientY >= c.top && e.clientY <= c.bottom;
      const snap = into ? undefined : onCompass ? gridAreaAt((e.clientX - c!.left) / c!.width, (e.clientY - c!.top) / c!.height) : snapAt(p.x, p.y, size.w, size.h);
      setPreview({ into, snap });
      setDraft(l);
    };
    const onUp = () => {
      const d = drag.current;
      if (!d) return;
      drag.current = null;
      let l = live.current;
      if (d.kind === "move" && d.started) {
        if (preview.into) l = mergeInto(l, preview.into, d.id);
        else if (preview.snap) l = snapGroup(l, d.id, preview.snap);
      }
      setDraft(null);
      setPreview({});
      if (d.kind === "resize" || d.started) commit.current(l);
      // The click that follows the drag's end isn't one.
      setTimeout(() => (dragged.current = false), 0);
    };
    addEventListener("pointermove", onMove);
    addEventListener("pointerup", onUp);
    addEventListener("pointercancel", onUp);
    return () => {
      removeEventListener("pointermove", onMove);
      removeEventListener("pointerup", onUp);
      removeEventListener("pointercancel", onUp);
    };
  });

  const startMove = (e: ReactPointerEvent, g: WindowGroup, tab?: PanelId) => {
    if (narrow || e.button !== 0) return;
    if (!tab && (e.target as HTMLElement).closest("button, input, select, textarea, a")) return;
    const r = windows.current.get(g.id)!.getBoundingClientRect();
    drag.current = { kind: "move", id: g.id, tab, sx: e.clientX, sy: e.clientY, dx: e.clientX - r.left, dy: e.clientY - r.top, started: false };
  };
  const startResize = (e: ReactPointerEvent, g: WindowGroup, dir: Dir) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    drag.current = { kind: "resize", id: g.id, dir, sx: e.clientX, sy: e.clientY, start: pxOf(g.rect) };
  };
  const toFront = (g: WindowGroup) => {
    if (!narrow && g.z < front) onLayout(focusGroup(layout, g.id));
  };
  const close = (tab: PanelId) => {
    const view = panels[tab];
    if (view?.onClose) view.onClose();
    else onLayout(closePanel(layout, tab));
  };

  const previewRect = preview.snap ? pxOf(snapRect(preview.snap)) : undefined;
  const moving = !!draft && drag.current?.kind === "move" && drag.current.started;

  return (
    <div ref={area} className="wm-area" data-dragging={!!draft}>
      <svg className="wm-lines" aria-hidden="true">
        {groups
          .filter((g) => panels[g.active]?.anchored)
          .map((g) => (
            <path key={g.id} ref={(el) => void (el ? lines.current.set(g.id, el) : lines.current.delete(g.id))} />
          ))}
      </svg>
      {previewRect && <div className="wm-preview" style={{ left: previewRect.l, top: previewRect.t, width: previewRect.w, height: previewRect.h }} />}
      {moving && (
        <div ref={compass} className="wm-compass" style={{ zIndex: 20 + front }} aria-hidden="true">
          {GRID_AREAS.map((a) => (
            <span key={a} className="wm-grid-cell" data-hot={preview.snap === a} />
          ))}
        </div>
      )}
      {size.w > 0 &&
        groups.map((g) => {
          const px = g.maximized ? { l: 0, t: 0, w: size.w, h: size.h } : pxOf(g.rect);
          const view = panels[g.active]!;
          const tabbed = g.tabs.length > 1;
          return (
            <section
              key={g.id}
              ref={(el) => void (el ? windows.current.set(g.id, el) : windows.current.delete(g.id))}
              className="wm-window"
              data-front={g.z === front}
              data-max={!!g.maximized}
              data-drop={preview.into === g.id}
              style={{ left: px.l, top: px.t, width: px.w, height: px.h, zIndex: 10 + g.z }}
              aria-label={view.title}
              onPointerDownCapture={() => toFront(g)}
            >
              <header
                ref={(el) => void (el ? headers.current.set(g.id, el) : headers.current.delete(g.id))}
                className="wm-header"
                onPointerDown={(e) => startMove(e, g)}
                onDoubleClick={(e) => !narrow && !(e.target as HTMLElement).closest("button") && onLayout(toggleMaximized(layout, g.id))}
              >
                {tabbed ? (
                  <div className="wm-tabs" role="tablist">
                    {g.tabs.map((tab) => {
                      const v = panels[tab]!;
                      return (
                        <button
                          key={tab}
                          type="button"
                          role="tab"
                          className="wm-tab"
                          aria-selected={tab === g.active}
                          title={v.heading ? `${v.title}: ${v.heading}` : v.title}
                          onPointerDown={(e) => (e.stopPropagation(), startMove(e, g, tab))}
                          onClick={() => !dragged.current && (narrow ? setNarrowTab(tab) : onLayout(activate(layout, tab)))}
                        >
                          <Icon name={v.icon} className="h-4 w-4 shrink-0" />
                          <span className="truncate">{v.title}</span>
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <div className="min-w-0 flex-1">
                    <h2 className="section-header truncate">{view.title}</h2>
                    {view.heading && (
                      <p className="truncate text-sm font-semibold" title={view.heading}>
                        {view.heading}
                      </p>
                    )}
                  </div>
                )}
                <span className="flex shrink-0 items-center">
                  {view.actions}
                  {!narrow && <WindowMenu group={g} groups={groups} panels={panels} layout={layout} onLayout={onLayout} />}
                  {!narrow && (
                    <button type="button" className="wm-button" onClick={() => onLayout(toggleMaximized(layout, g.id))} title={g.maximized ? t("twin:windows.restore") : t("twin:windows.maximize")} aria-label={g.maximized ? t("twin:windows.restore") : t("twin:windows.maximize")}>
                      <Icon name={g.maximized ? "close_fullscreen" : "open_in_full"} className="h-4 w-4" />
                    </button>
                  )}
                  <button type="button" className="wm-button" onClick={() => close(g.active)} title={t("twin:windows.close")} aria-label={t("twin:windows.close")}>
                    <Icon name="close" className="h-4 w-4" />
                  </button>
                </span>
              </header>
              {tabbed && view.heading && <p className="wm-subhead truncate" title={view.heading}>{view.heading}</p>}
              {g.tabs.map((tab) => (
                <div key={tab} className={`wm-body ${panels[tab]!.flush ? "" : "px-3 py-2"}`} hidden={tab !== g.active} role={tabbed ? "tabpanel" : undefined}>
                  {panels[tab]!.body}
                </div>
              ))}
              {!narrow && !g.maximized && RESIZE.map((dir) => <span key={dir} className="wm-resize" data-dir={dir} onPointerDown={(e) => startResize(e, g, dir)} aria-hidden="true" />)}
            </section>
          );
        })}
    </div>
  );
}

/** On a narrow screen: one window over the lower part of the view, every available panel a tab. */
function narrowGroup(l: WindowLayout, available: ReadonlySet<PanelId>, chosen?: PanelId): WindowGroup[] {
  const tabs = visibleGroups(l, available).flatMap((g) => g.tabs);
  if (!tabs.length) return [];
  const front = [...visibleGroups(l, available)].sort((a, b) => b.z - a.z)[0]!;
  const active = chosen && tabs.includes(chosen) ? chosen : front.active;
  return [{ id: "narrow", tabs, active, rect: { x: 0, y: 0.42, w: 1, h: 0.58 }, z: 1 }];
}

/** A window's menu: dock it in one of the area's 9 parts (drawn to scale), take its tab out, join another window. */
function WindowMenu({ group, groups, panels, layout, onLayout }: { group: WindowGroup; groups: WindowGroup[]; panels: Partial<Record<PanelId, PanelView>>; layout: WindowLayout; onLayout: (l: WindowLayout) => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  usePopupClose(open, box, () => setOpen(false));
  const others = groups.filter((g) => g.id !== group.id);
  const done = (l: WindowLayout) => (setOpen(false), onLayout(l));
  return (
    <span ref={box} className="relative">
      <button type="button" className="wm-button" onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open} title={t("twin:windows.arrange")} aria-label={t("twin:windows.arrange")}>
        <Icon name="more_vert" className="h-4 w-4" />
      </button>
      {open && (
        <div className="menu-popup end-0 w-56 p-2" role="menu" aria-label={t("twin:windows.arrange")}>
          <p className="section-header px-1">{t("twin:windows.snapTo")}</p>
          <div className="wm-grid mt-1">
            {GRID_AREAS.map((s) => (
              <button key={s} type="button" role="menuitem" className="wm-grid-cell" data-docked={group.dock === s} onClick={() => done(snapGroup(layout, group.id, s))} title={t(`twin:windows.snap.${s}`)} aria-label={t(`twin:windows.snap.${s}`)} />
            ))}
          </div>
          {group.tabs.length > 1 && (
            <button type="button" role="menuitem" className="list-row mt-2 block w-full rounded px-2 py-1 text-start text-sm" onClick={() => done(detach(layout, group.active, { ...group.rect, x: group.rect.x + 0.03, y: group.rect.y + 0.03 }).layout)}>
              {t("twin:windows.detach", { name: panels[group.active]?.title })}
            </button>
          )}
          {others.length > 0 && <p className="section-header mt-2 px-1">{t("twin:windows.joinWith")}</p>}
          {others.map((o) => (
            <button key={o.id} type="button" role="menuitem" className="list-row block w-full rounded px-2 py-1 text-start text-sm" onClick={() => done(mergeInto(layout, o.id, group.id))}>
              <Icon name="tab" className="me-1 h-4 w-4 align-[-0.2em]" />
              {o.tabs.map((x) => panels[x]?.title).join(", ")}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}
