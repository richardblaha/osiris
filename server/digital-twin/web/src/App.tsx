import type { DtdlModelData } from "@osiris/shared/dtdl.ts";
import { useEffect, useMemo, useRef, useState } from "react";
import { buildScene, type TwinScene } from "./scene.ts";
import { t } from "i18next";
import { api } from "./api.ts";
import { authOff, getAccessToken, login, logout } from "./auth.ts";
import { applyLanguageSetting, currentLocale } from "./i18n.ts";
import { attempt, ErrorNotice, Loading } from "./ui.tsx";
import { Logs, Metrics, Traces, type Preset } from "./Telemetry.tsx";
import { Twin3D, type Point } from "./Twin3D.tsx";
import { Timeline } from "./Timeline.tsx";
import { FocusPanels } from "./FocusPanels.tsx";

/** The views, in the URL's hash so a selection or a page survives reloading and signing in. */
type View =
  | { kind: "twin" }
  | { kind: "logs"; preset: Preset; traceId?: string }
  | { kind: "metrics"; preset: Preset }
  | { kind: "traces"; preset: Preset; traceId?: string };

const parseHash = (): View => {
  const params = new URLSearchParams(location.hash.replace(/^#\/?/, ""));
  const preset: Preset = { namespace: params.get("namespace") ?? undefined, pod: params.get("pod") ?? undefined };
  const kind = params.get("view");
  if (kind === "logs") return { kind: "logs", preset, traceId: params.get("traceId") ?? undefined };
  if (kind === "metrics") return { kind: "metrics", preset };
  if (kind === "traces") return { kind: "traces", preset, traceId: params.get("traceId") ?? undefined };
  return { kind: "twin" };
};

const toHash = (view: View) => {
  const params = new URLSearchParams();
  const preset = "preset" in view ? view.preset : undefined;
  if (preset?.namespace) params.set("namespace", preset.namespace);
  if (preset?.pod) params.set("pod", preset.pod);
  if (view.kind !== "twin") params.set("view", view.kind);
  if ("traceId" in view && view.traceId) params.set("traceId", view.traceId);
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
    at: number | null;
  }>();
  const [selectedId, setSelectedId] = useState<string>();
  /** Bumped by Escape with nothing selected: the camera flies back to the whole twin. */
  const [home, setHome] = useState(0);
  /** The selected box's corners on screen (the 3D view's), for the panels' lines. */
  const anchor = useRef<(() => Point[] | null) | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  // undefined while the stored token is being checked: nothing asks the API before it's known whether there is one.
  const [signedIn, setSignedIn] = useState<boolean | undefined>(authOff ? true : undefined);
  const [user, setUser] = useState<{ name: string | null } | null>(null);

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
    if (signedIn) void api.range().then((r) => setHistoryFrom(r.from ?? undefined), () => setHistoryFrom(undefined));
  }, [signedIn]);

  /** The twin loads once signed in and, live, refreshes every minute (the server syncs every 30 s). */
  const loadTwin = () =>
    attempt(setBusy, setError, async () => {
      const [m, twins, relationships, errors, network] = await Promise.all([
        models ? Promise.resolve(models) : api.models(),
        api.twins(at),
        api.relationships(at),
        api.errorLogs(at).catch(() => ({})),
        api.network(at).catch(() => ({})),
      ]);
      setModels(m);
      setData({ twins, relationships, errors, network, at });
    });
  const scene: TwinScene | undefined = useMemo(
    () => (models && data ? buildScene(models, data.twins, data.relationships, data.errors, data.network, data.at) : undefined),
    [models, data],
  );
  // The selection follows the refreshed scene (its new status and properties), or goes when its twin is gone.
  const selected = selectedId ? scene?.byId.get(selectedId) : undefined;
  useEffect(() => {
    if (!signedIn) return;
    void loadTwin();
    if (at !== null) return;
    const id = setInterval(() => void loadTwin(), 60_000);
    return () => clearInterval(id);
  }, [signedIn, at]);

  // After the OIDC redirect: back to where the user was; without a token the pages offer signing in.
  useEffect(() => {
    void getAccessToken().then((token) => {
      setSignedIn(!!token || authOff);
      if (token) void api.me().then(setUser, () => {});
    });
  }, []);

  // Escape: the selection goes and the camera flies back to the whole twin.
  useEffect(() => {
    if (view.kind !== "twin") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      setSelectedId(undefined);
      setHome((h) => h + 1);
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [view.kind]);

  const openFromNode = (page: "logs" | "metrics" | "traces") => {
    // Pages filter by the attributes that name the twin's telemetry (its otelResource: OpenTelemetry's k8s
    // namespace and pod).
    const otel = (selected?.twin.otelResource ?? {}) as Record<string, string>;
    navigate({ kind: page, preset: { namespace: otel["k8s.namespace.name"], pod: otel["k8s.pod.name"] } } as View);
  };

  const nav = [
    { key: "twin", view: { kind: "twin" } as View },
    { key: "logs", view: { kind: "logs", preset: {} } as View },
    { key: "metrics", view: { kind: "metrics", preset: {} } as View },
    { key: "traces", view: { kind: "traces", preset: {} } as View },
  ];

  return (
    <div className="flex h-full flex-col">
      <header className="flex shrink-0 items-center gap-4 border-b border-line bg-sidebar px-4 py-2">
        <span className="flex items-center gap-2 font-semibold tracking-widest">
          <img src="/favicon.svg" alt="" className="h-5 w-5" />
          OSIRIS <span className="text-fg-secondary">{t("common:title")}</span>
        </span>
        <nav className="flex items-center gap-1 text-sm" aria-label="Main">
          {nav.map(({ key, view: target }) => (
            <button key={key} type="button" onClick={() => navigate(target)} data-active={view.kind === key} className="list-row px-3 py-1">
              {t(key === "twin" ? "common:nav.twin" : key === "logs" ? "common:nav.logs" : key === "metrics" ? "common:nav.metrics" : "common:nav.traces")}
            </button>
          ))}
        </nav>
        <span className="flex-1" />
        <button
          type="button"
          className="list-row rounded px-2 py-1 text-xs"
          onClick={() => applyLanguageSetting(currentLocale() === "cs" ? "en" : "cs")}
        >
          {currentLocale() === "cs" ? "English" : "Česky"}
        </button>
        {signedIn ? (
          <span className="flex items-center gap-2 text-sm text-fg-secondary">
            {user?.name ?? ""}
            <button type="button" className="btn-secondary px-2 py-1 text-xs" onClick={() => void logout()}>
              {t("common:signOut")}
            </button>
          </span>
        ) : signedIn === false ? (
          <button type="button" className="btn-primary px-2 py-1 text-xs" onClick={() => void login(location.hash.slice(1))}>
            {t("common:signIn")}
          </button>
        ) : null}
      </header>

      <main className="min-h-0 flex-1">
        {signedIn === undefined ? (
          <div className="relative h-full">
            <Loading show />
          </div>
        ) : !signedIn ? (
          <div className="grid h-full place-items-center text-sm text-fg-muted">{t("common:signIn")}</div>
        ) : view.kind === "twin" ? (
          <div className="flex h-full flex-col">
            <div className="relative min-h-0 flex-1">
              <Loading show={busy && !scene} />
              <ErrorNotice error={error} />
              {scene ? (
                scene.top.length ? (
                  <Twin3D scene={scene} selected={selected} home={home} onSelect={(node) => setSelectedId(node.id)} anchor={anchor} />
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
                    onOpenPage={openFromNode}
                    onOpenTrace={(traceId) => navigate({ kind: "traces", preset: {}, traceId })}
                  />
                  <p className="twin-hint pointer-events-none absolute bottom-2 left-1/2 -translate-x-1/2 text-xs text-fg-muted">{t("twin:escHint")}</p>
                </>
              ) : (
                <>
                  <p className="pointer-events-none absolute bottom-2 start-4 text-xs text-fg-muted">{t("twin:hint")}</p>
                  <p className="pointer-events-none absolute top-2 start-4 text-xs text-fg-muted">{scene ? t("twin:counts.twins", { count: scene.byId.size }) : ""}</p>
                </>
              )}
            </div>
            {historyFrom !== undefined && <Timeline from={historyFrom} at={at} onChange={setAt} />}
          </div>
        ) : view.kind === "logs" ? (
          <Logs
            preset={view.preset}
            traceId={view.traceId}
            onOpenTrace={(traceId) => navigate({ kind: "traces", preset: view.preset, traceId })}
          />
        ) : view.kind === "metrics" ? (
          <Metrics preset={view.preset} />
        ) : (
          <Traces
            preset={view.preset}
            traceId={view.traceId}
            onOpenTrace={(traceId) => navigate({ kind: "traces", preset: view.preset, traceId })}
            onOpenLogs={(traceId) => navigate({ kind: "logs", preset: view.preset, traceId })}
          />
        )}
      </main>
    </div>
  );
}
