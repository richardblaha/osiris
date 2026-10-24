import { describe, expect, it } from "vitest";
import { Kube, type KubeObject } from "../src/kube.ts";
import { FINALIZER, Reconciler, type RuntimeProbe } from "../src/reconciler.ts";
import { projectResources, type OperatorSettings, type ProjectResource } from "../src/resources.ts";

/** The Kubernetes API in memory: apply merges, list filters by labels, merge patches update. */
class FakeKube extends Kube {
  objects = new Map<string, KubeObject>();
  private key = (kind: string, ns: string | undefined, name: string) => `${kind}/${ns ?? ""}/${name}`;

  override async apply(obj: KubeObject) {
    const k = this.key(obj.kind, obj.metadata.namespace, obj.metadata.name);
    const prev = this.objects.get(k);
    this.objects.set(k, { ...prev, ...obj, metadata: { ...prev?.metadata, ...obj.metadata } });
    return obj;
  }
  override async get<T>(kind: string, ns: string | undefined, name: string) {
    return (this.objects.get(this.key(kind, ns, name)) ?? null) as T | null;
  }
  override async list<T>(kind: string, ns: string | undefined, selector?: string) {
    const want = (selector ?? "").split(",").filter(Boolean).map((s) => s.split("="));
    return [...this.objects.values()].filter(
      (o) => o.kind === kind && o.metadata.namespace === ns && want.every(([k, v]) => o.metadata.labels?.[k!] === v),
    ) as T[];
  }
  override async delete(kind: string, ns: string | undefined, name: string) {
    this.objects.delete(this.key(kind, ns, name));
  }
  override async mergePatch(kind: string, ns: string | undefined, name: string, patch: Record<string, unknown>) {
    const o = this.objects.get(this.key(kind, ns, name))!;
    const merged = { ...o, ...patch, metadata: { ...o.metadata, ...(patch.metadata as object) } } as KubeObject;
    this.objects.set(this.key(kind, ns, name), merged);
    return merged;
  }
  replicas(project: string) {
    return (this.objects.get(this.key("StatefulSet", `osiris-p-${project}`, "runtime")) as { spec: { replicas: number } } | undefined)?.spec.replicas;
  }
  /** The pod came up (the kubelet's part). */
  ready(project: string) {
    const sts = this.objects.get(this.key("StatefulSet", `osiris-p-${project}`, "runtime"))!;
    (sts as { status?: object }).status = { readyReplicas: 1 };
  }
}

const settings: OperatorSettings = {
  namespace: "osiris",
  runtimeImage: "ghcr.io/x/osiris-runtime:1",
  storageClass: "civo-volume",
  controlUrl: "http://control.osiris.svc:3002",
  gotenbergUrl: "http://gotenberg.osiris.svc:3000",
  internalPublicKey: "PUBLIC",
  runtimeEnv: { LLM_MODEL: "mistralai:x" },
  runtimeSecrets: { MISTRAL_API_KEY: "k" },
  projectSecretsKey: (t) => `key-${t}`,
};

const T0 = Date.parse("2026-10-19T08:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

function setup() {
  const kube = new FakeKube();
  const probe = { lastActivity: T0, activeRuns: 0, snapshots: 0, refuse: false };
  const runtime: RuntimeProbe = {
    activity: async () => ({ lastActivity: probe.lastActivity, activeRuns: probe.activeRuns }),
    prepareSleep: async () => (probe.refuse ? false : (probe.snapshots++, true)),
  };
  const reconciler = new Reconciler(kube, settings, runtime, () => {});
  const project = async (spec: Partial<ProjectResource["spec"]> = {}, name = "acme") => {
    const existing = (await kube.get<ProjectResource>("Project", "osiris", name)) ?? {
      apiVersion: "osiris.k6labs.cz/v1alpha1",
      kind: "Project",
      metadata: { name, namespace: "osiris", creationTimestamp: iso(T0 - 3600_000) },
      spec: { displayName: name },
    };
    const t = { ...existing, spec: { ...existing.spec, ...spec } } as ProjectResource;
    kube.objects.set(`Project/osiris/${name}`, t);
    return t;
  };
  const reconcile = async (now: number, name = "acme") => reconciler.reconcile((await kube.get<ProjectResource>("Project", "osiris", name))!, now);
  return { kube, probe, project, reconcile };
}

describe("project resources", () => {
  it("run the runtime unprivileged, isolated and bound to its own volume", () => {
    const objects = projectResources({ apiVersion: "x", kind: "Project", metadata: { name: "acme" }, spec: { displayName: "ACME", storageGi: 10 } }, settings, 1);
    const by = (kind: string, name?: string) => objects.find((o) => o.kind === kind && (!name || o.metadata.name === name)) as Record<string, any>;
    expect(by("Namespace").metadata.labels["pod-security.kubernetes.io/enforce"]).toBe("restricted");
    const pod = by("StatefulSet").spec.template.spec;
    expect(pod.automountServiceAccountToken).toBe(false);
    expect(pod.containers[0].securityContext).toEqual({ allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] } });
    expect(pod.volumes[1].projected.sources[0].serviceAccountToken).toMatchObject({ audience: "osiris-control" });
    expect(by("StatefulSet").spec.volumeClaimTemplates[0].spec.resources.requests.storage).toBe("10Gi");
    expect(by("Secret", "runtime-env").stringData).toEqual({ PROJECT_SECRETS_KEY: "key-acme", MISTRAL_API_KEY: "k" });
    expect(by("ConfigMap").data).toMatchObject({ PROJECT_ID: "acme", LLM_MODEL: "mistralai:x", NODE_ENV: "production" });
    // Only the gateway, control and the operator reach the runtime; it reaches DNS, control, Gotenberg and the internet, not the cluster.
    const policy = by("NetworkPolicy", "runtime").spec;
    expect(policy.ingress[0].from[0].podSelector.matchExpressions[0].values).toEqual(["gateway", "control", "operator"]);
    expect(policy.egress.at(-1).to[0].ipBlock).toEqual({ cidr: "0.0.0.0/0", except: ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16", "100.64.0.0/10"] });
    expect(by("NetworkPolicy", "default-deny").spec).toEqual({ podSelector: {}, policyTypes: ["Ingress", "Egress"] });
  });
});

describe("reconciler", () => {
  it("keeps a new project asleep until woken, then sleeps it after the idle time with a snapshot first", async () => {
    const { kube, probe, project, reconcile } = setup();
    await project({ idleMinutes: 30 });
    await reconcile(T0);
    expect(kube.replicas("acme")).toBe(0);
    expect((await kube.get<ProjectResource>("Project", "osiris", "acme"))!.metadata.finalizers).toEqual([FINALIZER]);

    await project({ wakeRequestedAt: iso(T0 + 1000) });
    await reconcile(T0 + 2000);
    expect(kube.replicas("acme")).toBe(1);
    kube.ready("acme");

    // Used 10 minutes ago: stays up.
    probe.lastActivity = T0 + 50 * 60_000;
    await reconcile(T0 + 60 * 60_000);
    expect(kube.replicas("acme")).toBe(1);
    // A run in progress keeps it up however long it has been.
    probe.activeRuns = 1;
    await reconcile(T0 + 120 * 60_000);
    expect(kube.replicas("acme")).toBe(1);
    probe.activeRuns = 0;
    await reconcile(T0 + 121 * 60_000);
    expect(probe.snapshots).toBe(1);
    expect(kube.replicas("acme")).toBe(0);
    expect((await kube.get<ProjectResource>("Project", "osiris", "acme"))!.status).toMatchObject({ phase: "Sleeping", sleptAt: iso(T0 + 121 * 60_000) });

    // Woken again later.
    await project({ wakeRequestedAt: iso(T0 + 130 * 60_000) });
    await reconcile(T0 + 130 * 60_000);
    expect(kube.replicas("acme")).toBe(1);
  });

  it("keeps always-on projects running and suspended ones stopped", async () => {
    const { kube, project, reconcile } = setup();
    await project({ idleMinutes: 0 });
    await reconcile(T0);
    expect(kube.replicas("acme")).toBe(1);
    await project({ suspended: true, wakeRequestedAt: iso(T0 + 1000) });
    await reconcile(T0 + 2000);
    expect(kube.replicas("acme")).toBe(0);
    expect((await kube.get<ProjectResource>("Project", "osiris", "acme"))!.status?.phase).toBe("Suspended");
  });

  it("takes a last snapshot and removes the namespace when a Project is deleted", async () => {
    const { kube, probe, project, reconcile } = setup();
    await project({ idleMinutes: 0 });
    await reconcile(T0);
    kube.ready("acme");
    const t = (await kube.get<ProjectResource>("Project", "osiris", "acme"))!;
    kube.objects.set("Project/osiris/acme", { ...t, metadata: { ...t.metadata, deletionTimestamp: iso(T0 + 1000) } });
    await reconcile(T0 + 2000);
    expect(probe.snapshots).toBe(1);
    expect(await kube.get("Namespace", undefined, "osiris-p-acme")).toBeNull();
    expect((await kube.get<ProjectResource>("Project", "osiris", "acme"))!.metadata.finalizers).toEqual([]);
  });
});
