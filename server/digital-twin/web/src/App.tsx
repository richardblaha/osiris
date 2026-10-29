import type { DtdlModelData } from "@osiris/shared/dtdl.ts";
import { useEffect, useMemo, useRef, useState } from "react";
import { buildScene, scopeOf, type TwinScene } from "./scene.ts";
import { t } from "i18next";
import { api } from "./api.ts";
import { authOff, autoSignIn, getAccessToken, login, profile, signedInOk } from "./auth.ts";
import { UserMenu, type Profile } from "./UserMenu.tsx";
import { attempt, ErrorNotice, Loading } from "./ui.tsx";
import { Logs, Metrics, Traces, type Preset } from "./Telemetry.tsx";
import { Twin3D, type Point } from "./Twin3D.tsx";
import { Timeline } from "./Timeline.tsx";
import { FocusPanels } from "./FocusPanels.tsx";

/** The views, in the URL's hash so a selection or a page survives reloading and signing in: the twin is always there,
 * a telemetry page lies over it. */
type View =
  | { kind: "twin" }
  | { kind: "logs"; preset: Preset; traceId?: string }
  | { kind: "metrics"; preset: Preset }
  | { kind: "traces"; preset: Preset; traceId?: string };

const SCOPE = ["namespace", "pod", "node", "container", "claim"] as const;
type Page = "logs" | "metrics" | "traces";
const PAGES: Page[] = ["logs", "metrics", "traces"];

const parseHash = (): View => {
  const params = new URLSearchParams(location.hash.replace(/^#\/?/, ""));
  const preset: Preset = Object.fromEntries(SCOPE.map((k) => [k, params.get(k) ?? undefined]));
  const kind = params.get("view");
  if (kind === "logs") return { kind: "logs", preset, traceId: params.get("traceId") ?? undefined };
  if (kind === "metrics") return { kind: "metrics", preset };
  if (kind === "traces") return { kind: "traces", preset, traceId: params.get("traceId") ?? undefined };
  return { kind: "twin" };
};

const toHash = (view: View) => {
  const params = new URLSearchParams();
  const preset = "preset" in view ? view.preset : undefined;
  for (const k of SCOPE) if (preset?.[k]) params.set(k, preset[k]);
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
    storage: Record<string, { used: number; fsCapacity: number }>;
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
  const [user, setUser] = useState<Profile>();

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
    if (!signedIn) return;
    void loadTwin();
    if (at !== null) return;
    const id = setInterval(() => void loadTwin(), 60_000);
    return () => clearInterval(id);
  }, [signedIn, at]);

  // After the OIDC redirect: back to where the user was. Without a token, straight on to signing in (unless that just
  // failed: then the button).
  useEffect(() => {
    void getAccessToken().then(async (token) => {
      if (token || authOff) {
        signedInOk();
        setSignedIn(true);
        const [p, me] = await Promise.all([profile(), api.me().catch(() => null)]);
        setUser({ name: p?.name ?? me?.name ?? undefined, email: p?.email ?? me?.email ?? undefined, picture: p?.picture });
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
  const openPage = (page: Page) => navigate({ kind: page, preset: presetOf(page) } as View);
  /** A tab opens its page; the open page's tab closes it. */
  const toggle = (page: Page) => (view.kind === page ? navigate({ kind: "twin" }) : openPage(page));

  const tabLabel = (page: Page) => (page === "logs" ? t("common:nav.logs") : page === "metrics" ? t("common:nav.metrics") : t("common:nav.traces"));

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
                    onOpenPage={openPage}
                    onOpenTrace={(traceId) => navigate({ kind: "traces", preset: {}, traceId })}
                  />
                  <p className="twin-hint pointer-events-none absolute bottom-2 left-1/2 -translate-x-1/2 text-xs text-fg-muted">{t("twin:escHint")}</p>
                </>
              ) : (
                <>
                  <p className="pointer-events-none absolute bottom-2 start-4 text-xs text-fg-muted">{t("twin:hint")}</p>
                  <p className="twin-count pointer-events-none absolute start-4 text-xs text-fg-muted">{scene ? t("twin:counts.twins", { count: [...scene.byId.values()].filter((v) => !v.of).length }) : ""}</p>
                </>
              )}
            </div>
            {historyFrom !== undefined && <Timeline from={historyFrom} at={at} onChange={setAt} />}
          </>
        )}
      </main>

      {signedIn && view.kind !== "twin" && (
        <section className="page-overlay" aria-label={tabLabel(view.kind)}>
          {view.kind === "logs" ? (
            <Logs key={toHash(view)} preset={view.preset} traceId={view.traceId} onOpenTrace={(traceId) => navigate({ kind: "traces", preset: view.preset, traceId })} />
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

      {/* The bar over everything, see-through: the name, the pages in the middle, the user. */}
      <header className="app-bar">
        <span className="app-bar-brand">
          <img src="/favicon.svg" alt="" className="h-5 w-5" />
          OSIRIS <span className="text-fg-secondary">{t("common:title")}</span>
        </span>
        <nav className="app-bar-tabs" aria-label={t("common:nav.label")}>
          {PAGES.map((page) => (
            <button key={page} type="button" onClick={() => toggle(page)} data-active={view.kind === page} aria-pressed={view.kind === page} disabled={!signedIn} className="app-tab">
              {tabLabel(page)}
            </button>
          ))}
        </nav>
        <span className="app-bar-user">{signedIn && <UserMenu user={user} />}</span>
      </header>
    </div>
  );
}
