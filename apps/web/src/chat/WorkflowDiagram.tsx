import type { AgentNodeStatus, WorkflowView } from "@osiris/shared";
import { t } from "i18next";
import { useEffect, useState } from "react";

const W = 168;
const H = 46;
/** Wide enough for a lane's loops back. */
const GAP_X = 40;
const GAP_Y = 34;
/** Room for the loops back (repairs, reflections) right of a lane. */
const LOOP = 32;

const STATUS_CLASS: Record<AgentNodeStatus, string> = {
  pending: "text-fg-muted",
  running: "text-primary",
  success: "text-success",
  failed: "text-error",
  waiting_approval: "text-warning",
  skipped: "text-fg-muted opacity-60",
};
/** The run's own nodes are named by their phase; a step's by its goal. */
const OWN = new Set(["router", "verify", "complete"]);

type Layout = { pos: Map<string, { x: number; y: number }>; back: Set<string>; width: number; height: number };

/**
 * Rows by longest path from the start, the loops back (an edge to a node still being visited) left out of the ranking
 * and drawn beside their lane. The topology is the router's plan: a DAG of steps, with loops only inside a step.
 */
function layout(view: WorkflowView): Layout {
  const { nodes, edges } = view.topology;
  const out = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  for (const e of edges) out.get(e.from)?.push(e.to);
  const back = new Set<string>();
  const state = new Map<string, "open" | "done">();
  const visit = (id: string) => {
    state.set(id, "open");
    for (const to of out.get(id) ?? []) {
      if (state.get(to) === "open") back.add(`${id}>${to}`);
      else if (!state.has(to)) visit(to);
    }
    state.set(id, "done");
  };
  for (const n of nodes) if (!state.has(n.id)) visit(n.id);

  const rank = new Map<string, number>(nodes.map((n) => [n.id, 0]));
  // Longest path: relax forward edges as many times as there are nodes (a DAG settles well before).
  for (let i = 0; i < nodes.length; i++) {
    for (const e of edges) {
      if (back.has(`${e.from}>${e.to}`) || !rank.has(e.from) || !rank.has(e.to)) continue;
      rank.set(e.to, Math.max(rank.get(e.to)!, rank.get(e.from)! + 1));
    }
  }
  // Each step keeps to one lane (its loops stay beside it); steps whose rows don't overlap share one. The run's own
  // nodes (router, verify, complete) sit in the middle.
  const span = new Map<string, [number, number]>();
  for (const n of nodes) {
    if (OWN.has(n.id)) continue;
    const step = n.id.split("/")[0]!;
    const r = rank.get(n.id)!;
    const [lo, hi] = span.get(step) ?? [r, r];
    span.set(step, [Math.min(lo, r), Math.max(hi, r)]);
  }
  const laneEnds: number[] = [];
  const lane = new Map<string, number>();
  for (const [step, [lo, hi]] of [...span].sort((a, b) => a[1][0] - b[1][0])) {
    let l = laneEnds.findIndex((end) => end < lo);
    if (l < 0) l = laneEnds.length;
    laneEnds[l] = hi;
    lane.set(step, l);
  }
  const lanes = Math.max(laneEnds.length, 1);
  const width = lanes * W + (lanes - 1) * GAP_X + LOOP;
  const rows = Math.max(...rank.values()) + 1;
  const pos = new Map<string, { x: number; y: number }>();
  for (const n of nodes) {
    const x = OWN.has(n.id) ? (width - LOOP - W) / 2 : lane.get(n.id.split("/")[0]!)! * (W + GAP_X);
    pos.set(n.id, { x, y: rank.get(n.id)! * (H + GAP_Y) });
  }
  return { pos, back, width, height: rows * H + (rows - 1) * GAP_Y };
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** Seconds since `at`, ticking while `live`. */
function useSince(at: number | undefined, live: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);
  return at === undefined ? 0 : Math.max(0, Math.round((now - at) / 1000));
}

/**
 * A workflow's graph, each node colored by its state as the run's events arrive, with what happened last under it
 * (where the chat's newest lines are) while it runs. A finished one opens folded to its summary.
 */
export function WorkflowDiagram({ view, running }: { view: WorkflowView; running: boolean }) {
  const { pos, back, width, height } = layout(view);
  const states = Object.values(view.nodes);
  const count = (status: AgentNodeStatus) => states.filter((s) => s.status === status).length;
  const waiting = count("waiting_approval") > 0;
  // Busy while its tool hasn't answered; waiting for an approval is the user's turn, not work.
  const live = running && !waiting;
  const since = useSince(view.latest?.at, live);
  const latestNode = view.topology.nodes.find((n) => n.id === view.latest?.nodeId);
  const latestLabel = latestNode && (OWN.has(latestNode.id) ? t(`chat:workflow.phase.${latestNode.type}`) : latestNode.label);
  const [open, setOpen] = useState(live || waiting);
  return (
    <details open={open} onToggle={(e) => setOpen(e.currentTarget.open)} className="my-2 rounded-md border border-line bg-canvas p-3">
      <summary className="flex cursor-pointer flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fg-secondary">
        <span className="font-medium text-fg">{t(`chat:workflow.pattern.${view.pattern}`)}</span>
        <span>{t("chat:workflow.progress", { done: count("success"), total: states.length })}</span>
        {count("failed") > 0 && <span className="text-error">{t("chat:workflow.failedCount", { count: count("failed") })}</span>}
        {count("skipped") > 0 && <span>{t("chat:workflow.skippedCount", { count: count("skipped") })}</span>}
      </summary>
      <div className="mt-2 overflow-x-auto">
        <svg viewBox={`-4 -4 ${width + 8} ${height + 8}`} width={width + 8} className="block max-w-none" role="img" aria-label={t("chat:workflow.label")}>
          <defs>
            <marker id="wf-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0 0L8 4L0 8z" fill="currentColor" />
            </marker>
          </defs>
          {view.topology.edges.map((e) => {
            const a = pos.get(e.from);
            const b = pos.get(e.to);
            if (!a || !b) return null;
            const loop = back.has(`${e.from}>${e.to}`);
            const lit = view.nodes[e.from]?.status === "success";
            const d = loop
              ? `M${a.x + W} ${a.y + H / 2} C${a.x + W + LOOP - 4} ${a.y + H / 2} ${b.x + W + LOOP - 4} ${b.y + H / 2} ${b.x + W} ${b.y + H / 2}`
              : `M${a.x + W / 2} ${a.y + H} C${a.x + W / 2} ${a.y + H + GAP_Y / 2} ${b.x + W / 2} ${b.y - GAP_Y / 2} ${b.x + W / 2} ${b.y}`;
            return (
              <g key={`${e.from}>${e.to}`} className={lit ? "text-success" : "text-line-strong"}>
                <path d={d} fill="none" stroke="currentColor" strokeWidth={1.4} strokeDasharray={loop ? "4 3" : undefined} markerEnd="url(#wf-arrow)" />
                {e.condition && <title>{e.condition}</title>}
              </g>
            );
          })}
          {view.topology.nodes.map((n) => {
            const p = pos.get(n.id)!;
            const state = view.nodes[n.id] ?? { status: "pending" as const, message: n.label };
            const label = OWN.has(n.id) ? t(`chat:workflow.phase.${n.type}`) : n.label;
            return (
              <g key={n.id} transform={`translate(${p.x} ${p.y})`} className={STATUS_CLASS[state.status]}>
                <title>{`${label}\n${t(`chat:workflow.status.${state.status}`)}${state.message && state.message !== n.label ? `: ${state.message}` : ""}`}</title>
                <rect
                  width={W}
                  height={H}
                  rx={6}
                  fill="var(--color-canvas)"
                  stroke="currentColor"
                  strokeWidth={state.status === "running" || state.status === "waiting_approval" ? 2.2 : 1.4}
                  strokeDasharray={state.status === "skipped" ? "4 3" : undefined}
                  className={state.status === "running" ? "animate-pulse" : undefined}
                />
                <text x={10} y={17} fontSize={10} fill="currentColor">
                  {t(`chat:workflow.phase.${n.type}`)} · {t(`chat:workflow.status.${state.status}`)}
                </text>
                <text x={10} y={34} fontSize={12} fill="var(--color-fg)">
                  {clip(label, 24)}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      {(live || waiting) && view.latest && latestLabel && (
        <p className="mt-2 flex items-center gap-2 text-xs text-fg-secondary" role="status">
          {live && <span className="tool-spinner" aria-hidden="true" />}
          <span className="min-w-0 truncate">
            {t("chat:workflow.now", { node: clip(latestLabel, 40), message: clip(view.latest.message, 80), seconds: since })}
          </span>
        </p>
      )}
    </details>
  );
}
