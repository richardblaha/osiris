import type { Twin, TwinNode } from "@osiris/shared";
import { useEffect, useState } from "react";
import { t } from "i18next";
import { api } from "./api.ts";
import { authOff, getAccessToken, login, logout } from "./auth.ts";
import { applyLanguageSetting, currentLocale } from "./i18n.ts";
import { attempt, ErrorNotice, Loading } from "./ui.tsx";
import { Logs, Metrics, Traces, type Preset } from "./Telemetry.tsx";
import { Twin3D } from "./Twin3D.tsx";
import { TwinDetail } from "./TwinDetail.tsx";

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
  const [twin, setTwin] = useState<Twin>();
  const [selected, setSelected] = useState<TwinNode>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [signedIn, setSignedIn] = useState(!authOff);
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

  /** The twin loads with the app and refreshes every minute (the server caches it in Redis anyway). */
  const loadTwin = () => attempt(setBusy, setError, async () => setTwin(await api.twin()));
  useEffect(() => {
    void loadTwin();
    const id = setInterval(() => void loadTwin(), 60_000);
    return () => clearInterval(id);
  }, []);

  // After the OIDC redirect: back to where the user was; without a token the pages offer signing in.
  useEffect(() => {
    void getAccessToken().then((token) => {
      setSignedIn(!!token || authOff);
      if (token) void api.me().then(setUser, () => {});
    });
  }, []);

  const openFromNode = (page: "logs" | "metrics" | "traces") => {
    const node = selected ?? twin?.cluster;
    if (!node) return;
    // Pages filter by the node's namespace (a pod or container by the pod's own name, too).
    const ns = node.kind === "cluster" ? undefined : node.kind === "namespace" ? node.name : findKind(node, "namespace")?.name;
    const pod = node.kind === "pod" ? node.name : node.kind === "container" ? findKind(node, "pod")?.name : undefined;
    navigate({ kind: page, preset: { namespace: ns, pod } } as View);
  };

  /** Walks up: a node knows its place in the tree only through the path it came by. */
  const findKind = (node: TwinNode, kind: TwinNode["kind"]): TwinNode | undefined => {
    const walk = (at: TwinNode, trail: TwinNode[]): TwinNode[] => {
      const next = [...trail, at];
      if (at.id === node.id) return next;
      for (const child of at.children) {
        const found = walk(child, next);
        if (found) return found;
      }
      return [];
    };
    return twin ? walk(twin.cluster, []).find((n) => n.kind === kind) : undefined;
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
        ) : (
          <button type="button" className="btn-primary px-2 py-1 text-xs" onClick={() => void login(location.hash.slice(1))}>
            {t("common:signIn")}
          </button>
        )}
      </header>

      <main className="min-h-0 flex-1">
        {!signedIn ? (
          <div className="grid h-full place-items-center text-sm text-fg-muted">{t("common:signIn")}</div>
        ) : view.kind === "twin" ? (
          <div className="flex h-full">
            <div className="relative min-w-0 flex-1">
              <Loading show={busy && !twin} />
              <ErrorNotice error={error} />
              {twin ? (
                twin.cluster.children.length ? (
                  <Twin3D twin={twin} selected={selected} onSelect={(node) => setSelected(node)} />
                ) : (
                  <p className="grid h-full place-items-center text-sm text-fg-muted">{t("twin:empty")}</p>
                )
              ) : null}
              <p className="pointer-events-none absolute bottom-2 start-4 text-xs text-fg-muted">{t("twin:hint")}</p>
              <p className="pointer-events-none absolute top-2 start-4 text-xs text-fg-muted">
                {t("twin:counts.namespaces", { count: twin?.cluster.children.length ?? 0 })}
                {twin ? ` · ${t("twin:counts.pods", { count: countPods(twin.cluster) })}` : ""}
              </p>
            </div>
            {selected ? <TwinDetail node={selected} onOpen={openFromNode} /> : <p className="pointer-events-none absolute end-4 top-2 hidden text-xs text-fg-muted md:block">{t("twin:noSelection")}</p>}
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

const countPods = (node: TwinNode): number => {
  let n = 0;
  for (const child of node.children) n += child.kind === "pod" ? 1 : countPods(child);
  return n;
};
