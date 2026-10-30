import type { DtdlModelData } from "@osiris/shared/dtdl.ts";
import { useEffect, useMemo, useRef, useState } from "react";
import { buildScene, scopeOf, type TwinScene } from "./scene.ts";
import { t } from "i18next";
import { api, currentInstance, setInstance, type DashboardSummary, type InstanceSummary } from "./api.ts";
import { Instances } from "./Instances.tsx";
import { InstanceMenu } from "./InstanceMenu.tsx";
import { authOff, autoSignIn, getAccessToken, login, profile, signedInOk } from "./auth.ts";
import { UserMenu, type Profile } from "./UserMenu.tsx";
import { attempt, ErrorNotice, Loading } from "./ui.tsx";
import { Logs, Metrics, Traces, type Preset } from "./Telemetry.tsx";
import { ALL_LAYERS, Twin3D, type CameraControl, type Layers, type Point } from "./Twin3D.tsx";
import { Legend } from "./Legend.tsx";
import { OsirisChat, type TwinAction } from "./OsirisChat.tsx";
import { Timeline } from "./Timeline.tsx";
import { FocusPanels } from "./FocusPanels.tsx";
import { Dashboard, DashboardMenu } from "./Dashboard.tsx";

/** The views, in the URL's hash so a selection or a page survives reloading and signing in: the twin is always there,
 * a telemetry page lies over it. */
type View =
  | { kind: "twin" }
  | { kind: "dashboard"; id?: string }
  | { kind: "logs"; preset: Preset; filter?: Record<string, string>; traceId?: string }
  | { kind: "metrics"; preset: Preset }
  | { kind: "traces"; preset: Preset; traceId?: string }
  | { kind: "instances" };

const SCOPE = ["namespace", "pod", "node", "container", "claim"] as const;
/** The logs page's own filters (besides the scope), kept in the URL. */
const LOG_FILTERS = ["service", "severity", "q", "range", "from", "to"] as const;
type Page = "dashboard" | "logs" | "metrics" | "traces";
const PAGES: Page[] = ["dashboard", "logs", "metrics", "traces"];
const split = (values: Record<string, string>) => ({
  preset: Object.fromEntries(SCOPE.filter((k) => values[k]).map((k) => [k, values[k]])) as Preset,
  filter: Object.fromEntries(LOG_FILTERS.filter((k) => values[k]).map((k) => [k, values[k]!])),
});

const parseHash = (): View => {
  const params = new URLSearchParams(location.hash.replace(/^#\/?/, ""));
  const preset: Preset = Object.fromEntries(SCOPE.map((k) => [k, params.get(k) ?? undefined]));
  const kind = params.get("view");
  if (kind === "dashboard") return { kind: "dashboard", id: params.get("id") ?? undefined };
  if (kind === "logs")
    return { kind: "logs", preset, filter: Object.fromEntries(LOG_FILTERS.flatMap((k) => (params.get(k) ? [[k, params.get(k)!]] : []))), traceId: params.get("traceId") ?? undefined };
  if (kind === "metrics") return { kind: "metrics", preset };
  if (kind === "traces") return { kind: "traces", preset, traceId: params.get("traceId") ?? undefined };
  if (kind === "instances") return { kind: "instances" };
  return { kind: "twin" };
};

/** The twin the URL names (`twin=`), so a link opens the same twin. */
const hashInstance = () => new URLSearchParams(location.hash.replace(/^#\/?/, "")).get("twin") ?? undefined;
const INSTANCE_KEY = "osiris.digital-twin.instance";
const rememberedInstance = () => {
  try {
    return localStorage.getItem(INSTANCE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
};

const toHash = (view: View) => {
  const params = new URLSearchParams();
  if (currentInstance()) params.set("twin", currentInstance());
  const preset = "preset" in view ? view.preset : undefined;
  for (const k of SCOPE) if (preset?.[k]) params.set(k, preset[k]);
  if (view.kind !== "twin") params.set("view", view.kind);
  if ("traceId" in view && view.traceId) params.set("traceId", view.traceId);
  if (view.kind === "logs") for (const [k, v] of Object.entries(view.filter ?? {})) params.set(k, v);
  if (view.kind === "dashboard" && view.id) params.set("id", view.id);
  return `#/?${params}`;
};

export function App() {
  const [view, setView] = useState<View>(parseHash);
  /** The DTDL models, loaded once; the twins, their relationships and error counts, live or at `at`. */
  const [models, setModels] = useState<DtdlModelData[]>();
  const [data, setData] = useState<{
    twins: Awaited<ReturnType<typeof api.twins>>;
    relationships: Awaited<ReturnType<typeof api.relationships>>;
    errors: Record<string, number>;
    network: Record<string, number>;
    storage: Record<string, { used: number; fsCapacity: number }>;
    at: number | null;
  }>();
  const [selectedId, setSelectedId] = useState<string>();
  /** Bumped by Escape with nothing selected: the camera flies back to the whole twin. */
  const [home, setHome] = useState(0);
  /** The selected box's corners on screen (the 3D view's), for the panels' lines. */
  const anchor = useRef<(() => Point[] | null) | null>(null);
  /** The layers the 3D view shows (network, storage, logical groupings), kept in this browser. */
  const [layers, setLayers] = useState<Layers>(() => {
    try {
      return { ...ALL_LAYERS, ...(JSON.parse(localStorage.getItem("osiris.digital-twin.layers") ?? "{}") as Partial<Layers>) };
    } catch {
      return ALL_LAYERS;
    }
  });
  const changeLayers = (next: Layers) => {
    setLayers(next);
    try {
      localStorage.setItem("osiris.digital-twin.layers", JSON.stringify(next));
    } catch {
      // The choice lasts as long as the page.
    }
  };
  /** The camera, for the agent's turns, tilts and zooms. */
  const camera = useRef<CameraControl | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  // undefined while the stored token is being checked: nothing asks the API before it's known whether there is one.
  const [signedIn, setSignedIn] = useState<boolean | undefined>(authOff ? true : undefined);
  const [user, setUser] = useState<Profile>();
  /** The twins the user may see, the one shown, and whether the user manages them (an admin). */
  const [instances, setInstances] = useState<InstanceSummary[]>();
  const [instance, setInstanceState] = useState<string>();
  const [admin, setAdmin] = useState(false);
  /** Shows another twin: everything of the one before goes (its scene, selection, time, dashboards). */
  const chooseInstance = (id: string | undefined) => {
    if (id === instance) return;
    setInstance(id ?? "");
    try {
      if (id) localStorage.setItem(INSTANCE_KEY, id);
    } catch {
      // Remembered as long as the page.
    }
    setModels(undefined);
    setData(undefined);
    setSelectedId(undefined);
    setAt(null);
    setHistoryFrom(undefined);
    setDashboards([]);
    setInstanceState(id);
    // Another twin (not the first one chosen): its pages start over, on the twin.
    if (instance && view.kind !== "instances") navigate({ kind: "twin" });
  };
  const loadInstances = async (prefer?: string) => {
    const list = await api.instances();
    setInstances(list);
    const want = [prefer, instance, hashInstance(), rememberedInstance()].find((id) => id && list.some((i) => i.id === id)) ?? list[0]?.id;
    if (want !== instance) chooseInstance(want);
    return list;
  };

  useEffect(() => {
    const onHash = () => setView(parseHash());
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);

  const navigate = (next: View) => {
    location.hash = toHash(next).slice(1);
    setView(next);
  };

  /** The time the twin shows: null is live, else the recorded state at that time (epoch ms). */
  const [at, setAt] = useState<number | null>(null);
  /** How far back the recorded history goes; undefined while there is none (or it's off). */
  const [historyFrom, setHistoryFrom] = useState<number>();
  useEffect(() => {
    if (signedIn && instance) void api.range().then((r) => setHistoryFrom(r.from ?? undefined), () => setHistoryFrom(undefined));
  }, [signedIn, instance]);

  /** The twin loads once signed in and, live, refreshes every minute (the server syncs every 30 s). */
  const loadTwin = () =>
    attempt(setBusy, setError, async () => {
      const [m, twins, relationships, errors, network, storage] = await Promise.all([
        models ? Promise.resolve(models) : api.models(),
        api.twins(at),
        api.relationships(at),
        api.errorLogs(at).catch(() => ({})),
        api.network(at).catch(() => ({})),
        api.storage(at).catch(() => ({})),
      ]);
      setModels(m);
      setData({ twins, relationships, errors, network, storage, at });
    });
  const scene: TwinScene | undefined = useMemo(
    () => (models && data ? buildScene(models, data.twins, data.relationships, data.errors, data.network, data.storage, data.at) : undefined),
    [models, data],
  );
  // The selection follows the refreshed scene (its new status and properties), or goes when its twin is gone.
  const selected = selectedId ? scene?.byId.get(selectedId) : undefined;
  useEffect(() => {
    if (!signedIn || !instance) return;
    void loadTwin();
    if (at !== null) return;
    const id = setInterval(() => void loadTwin(), 60_000);
    return () => clearInterval(id);
  }, [signedIn, at, instance]);

  // After the OIDC redirect: back to where the user was. Without a token, straight on to signing in (unless that just
  // failed: then the button).
  useEffect(() => {
    void getAccessToken().then(async (token) => {
      if (token || authOff) {
        signedInOk();
        setSignedIn(true);
        const [p, me] = await Promise.all([profile(), api.me().catch(() => null), loadInstances().catch((e: Error) => setError(e.message))]);
        setAdmin(authOff || !!me?.admin);
        // The picture osiris-auth's introspection names (the ID token's when the API has none).
        setUser({ name: me?.name ?? p?.name ?? undefined, email: me?.email ?? p?.email ?? undefined, picture: me?.picture ?? p?.picture });
        return;
      }
      if (!autoSignIn()) setSignedIn(false);
    });
  }, []);

  // Escape: a page closes first; on the twin the first closes the selection's panels (the camera stays), the next flies
  // back to the whole twin. Menus and pop-ups take their Escape before (they prevent it).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (view.kind !== "twin") navigate({ kind: "twin" });
      else if (selectedId) setSelectedId(undefined);
      else setHome((h) => h + 1);
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [view.kind, selectedId]);

  /** A page opens filtered by the selected twin's telemetry (its namespace, pod, node or container). */
  const presetOf = (page: Page): Preset => {
    const scope = selected ? scopeOf(selected) : {};
    // Logs and traces name no volume claims, traces no containers.
    return page === "metrics" ? scope : { ...scope, claim: undefined, container: page === "traces" ? undefined : scope.container };
  };
  const openPage = (page: Exclude<Page, "dashboard">) => navigate({ kind: page, preset: presetOf(page) } as View);

  /** The dashboards' names, for the Overview tab's choice; reloaded when one is made, renamed or deleted. */
  const [dashboards, setDashboards] = useState<DashboardSummary[]>([]);
  const [choosing, setChoosing] = useState(false);
  const loadDashboards = () => api.dashboards().then((l) => (setDashboards(l), l));
  useEffect(() => {
    if (signedIn && instance) void loadDashboards().catch(() => {});
  }, [signedIn, instance]);
  /** Overview: with several dashboards a choice first, with one that one, with none a new one. */
  const openOverview = async () => {
    const list = await loadDashboards().catch(() => dashboards);
    if (list.length > 1) setChoosing(true);
    else navigate({ kind: "dashboard", id: list[0]?.id });
  };
  /** A tab opens its page; the open page's tab closes it. */
  const toggle = (page: Page) => {
    setChoosing(false);
    if (view.kind === page) navigate({ kind: "twin" });
    else if (page === "dashboard") void openOverview();
    else openPage(page);
  };
  /** The logs page with a filter's values (from a dashboard): its scope and its own filters. */
  const openLogs = (values: Record<string, string>) => navigate({ kind: "logs", ...split(values) });

  /** The twin, its newest scene, for the agent's steps (they run after a render or two). */
  const latest = useRef(scene);
  latest.current = scene;
  /**
   * The agent's steps for the view (twin_view), one after another with time for each flight: select by name or id
   * (an exact name first, then a part of one), turn, tilt, zoom, go home, open a page with a filter, go back in time.
   */
  const runTwin = async (steps: TwinAction[]) => {
    const pause = () => new Promise((r) => setTimeout(r, 950));
    for (const step of steps) {
      const views = [...(latest.current?.byId.values() ?? [])];
      if (step.action === "select") {
        const want = step.target.toLowerCase();
        const match =
          views.find((v) => v.id === step.target) ??
          views.find((v) => v.name.toLowerCase() === want && !v.of) ??
          views.find((v) => v.name.toLowerCase() === want) ??
          views.find((v) => v.name.toLowerCase().includes(want) && !v.of);
        if (match) (navigate({ kind: "twin" }), setSelectedId(match.id));
      } else if (step.action === "clear") setSelectedId(undefined);
      else if (step.action === "home") (setSelectedId(undefined), setHome((h) => h + 1));
      else if (step.action === "rotate") camera.current?.rotate(step.degrees);
      else if (step.action === "tilt") camera.current?.tilt(step.degrees);
      else if (step.action === "zoom") camera.current?.zoom(step.factor);
      else if (step.action === "close") navigate({ kind: "twin" });
      else if (step.action === "history") setAt(step.at && !Number.isNaN(Date.parse(step.at)) ? Date.parse(step.at) : null);
      else if (step.action === "open") {
        if (step.page === "dashboard") navigate({ kind: "dashboard", id: step.filter?.id });
        else if (step.page === "logs") openLogs(step.filter ?? {});
        else navigate({ kind: step.page, preset: split(step.filter ?? {}).preset } as View);
      }
      await pause();
    }
  };

  const tabLabel = (page: Page | "instances") =>
    page === "instances" ? t("instances:title") :
    page === "dashboard" ? t("common:nav.dashboard") : page === "logs" ? t("common:nav.logs") : page === "metrics" ? t("common:nav.metrics") : t("common:nav.traces");

  return (
    <div className="relative h-full overflow-hidden">
      <main className="flex h-full flex-col">
        {signedIn === undefined ? (
          <div className="relative h-full">
            <Loading show />
          </div>
        ) : !signedIn ? (
          <div className="grid h-full place-items-center">
            <button type="button" className="btn-primary" onClick={() => void login(location.hash.slice(1))}>
              {t("common:signIn")}
            </button>
          </div>
        ) : (
          <>
            <div className="relative min-h-0 flex-1">
              <Loading show={busy && !scene} />
              <div className="twin-chrome">
                <ErrorNotice error={error} />
              </div>
              {instances && !instances.length ? (
                <div className="grid h-full place-items-center p-6 text-center">
                  <div>
                    <p className="text-sm text-fg-muted">{admin ? t("instances:noneAdmin") : t("instances:none")}</p>
                    {admin && (
                      <button type="button" className="btn-primary mt-3" onClick={() => navigate({ kind: "instances" })}>
                        {t("instances:createFirst")}
                      </button>
                    )}
                  </div>
                </div>
              ) : scene ? (
                scene.top.length ? (
                  <Twin3D scene={scene} selected={selected} home={home} onSelect={(node) => setSelectedId(node.id)} anchor={anchor} control={camera} layers={layers} />
                ) : (
                  <p className="grid h-full place-items-center text-sm text-fg-muted">{t("twin:empty")}</p>
                )
              ) : null}
              {selected && scene ? (
                <>
                  <FocusPanels
                    key={selected.id}
                    node={selected}
                    scene={scene}
                    anchor={anchor}
                    onSelect={setSelectedId}
                    onOpenPage={openPage}
                    onOpenTrace={(traceId) => navigate({ kind: "traces", preset: {}, traceId })}
                  />
                  <p className="twin-hint pointer-events-none absolute bottom-2 start-4 text-xs text-fg-muted">{t("twin:escHint")}</p>
                </>
              ) : (
                <>
                  <p className="pointer-events-none absolute bottom-2 start-4 text-xs text-fg-muted">{t("twin:hint")}</p>
                  <Legend layers={layers} onLayers={changeLayers} count={scene ? t("twin:counts.twins", { count: [...scene.byId.values()].filter((v) => !v.of).length }) : ""} />
                </>
              )}
            </div>
            {historyFrom !== undefined && <Timeline from={historyFrom} at={at} onChange={setAt} />}
          </>
        )}
      </main>

      {signedIn && view.kind !== "twin" && (instance || view.kind === "instances") && (
        <section className="page-overlay" aria-label={tabLabel(view.kind)}>
          {view.kind === "instances" ? (
            <Instances onChanged={(id) => void loadInstances(id).catch(() => {})} />
          ) : view.kind === "dashboard" ? (
            <Dashboard
              id={view.id}
              list={dashboards}
              onSwitch={(id) => navigate({ kind: "dashboard", id })}
              onListChanged={(id) => void loadDashboards().then(() => navigate({ kind: "dashboard", id }))}
              onOpenLogs={openLogs}
              onOpenTrace={(traceId) => navigate({ kind: "traces", preset: {}, traceId })}
            />
          ) : view.kind === "logs" ? (
            <Logs
              key={toHash(view)}
              preset={view.preset}
              initial={view.filter}
              traceId={view.traceId}
              onOpenTrace={(traceId) => navigate({ kind: "traces", preset: view.preset, traceId })}
              // The filters stay in the URL (reloading or sharing keeps them) without opening the page again.
              onFilters={(values) => history.replaceState(null, "", toHash({ kind: "logs", ...split(values), traceId: view.traceId }))}
            />
          ) : view.kind === "metrics" ? (
            <Metrics key={toHash(view)} preset={view.preset} />
          ) : (
            <Traces
              key={toHash(view)}
              preset={view.preset}
              traceId={view.traceId}
              onOpenTrace={(traceId) => navigate({ kind: "traces", preset: view.preset, traceId })}
              onOpenLogs={(traceId) => navigate({ kind: "logs", preset: view.preset, traceId })}
            />
          )}
        </section>
      )}

      {signedIn && <OsirisChat onTwin={(steps) => void runTwin(steps)} />}

      {/* The bar over everything, see-through: the name, the pages in the middle, the user. */}
      <header className="app-bar">
        <span className="app-bar-brand">
          <img src="/favicon.svg" alt="" className="h-5 w-5" />
          OSIRIS <span className="text-fg-secondary">{t("common:title")}</span>
          {signedIn && (instances?.length || admin) ? (
            <InstanceMenu list={instances ?? []} current={instance} admin={admin} onPick={chooseInstance} onManage={() => navigate({ kind: "instances" })} />
          ) : null}
        </span>
        <nav className="app-bar-tabs" aria-label={t("common:nav.label")}>
          {PAGES.map((page) => (
            <span key={page} className="relative">
              <button
                type="button"
                onClick={() => toggle(page)}
                data-active={view.kind === page}
                aria-pressed={view.kind === page}
                aria-haspopup={page === "dashboard" && dashboards.length > 1 ? "menu" : undefined}
                aria-expanded={page === "dashboard" ? choosing : undefined}
                disabled={!signedIn || !instance}
                className="app-tab"
              >
                {tabLabel(page)}
                {page === "dashboard" && dashboards.length > 1 && <span aria-hidden="true"> ▾</span>}
              </button>
              {page === "dashboard" && choosing && (
                <DashboardMenu list={dashboards} onPick={(id) => (setChoosing(false), navigate({ kind: "dashboard", id }))} onClose={() => setChoosing(false)} />
              )}
            </span>
          ))}
        </nav>
        <span className="app-bar-user">{signedIn && <UserMenu user={user} />}</span>
      </header>
    </div>
  );
}
