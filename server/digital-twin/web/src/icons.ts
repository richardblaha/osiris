import { K8S_ICONS } from "./k8s-icons.ts";
import type { Look } from "@osiris/shared/dtdl.ts";
import type { TwinView } from "./scene.ts";

export type { Look };

/** A heptagon like the Kubernetes icons', in a 0..18 box. */
const heptagon = Array.from({ length: 7 }, (_, i) => {
  const a = -Math.PI / 2 + (i * 2 * Math.PI) / 7;
  return `${(9 + 8.4 * Math.cos(a)).toFixed(2)},${(9.2 + 8.4 * Math.sin(a)).toFixed(2)}`;
}).join(" ");

/** The Kubernetes set has no container icon: one in its style, a box with its lid. */
const CONTAINER = {
  viewBox: "0 0 18 18",
  body: `<polygon class="bg" points="${heptagon}"/><rect class="glyph" x="5" y="6.5" width="8" height="6"/><path class="line" d="M5 8.4 H13 M7.2 8.4 V12.5 M10.8 8.4 V12.5"/>`,
};

/** Workloads by the kind of what owns their pods. */
const WORKLOADS: Record<string, string> = { Deployment: "deploy", StatefulSet: "sts", DaemonSet: "ds", Job: "job", CronJob: "cronjob", ReplicaSet: "rs", Pod: "pod" };
/** The icon of each model, by its DTMI without the version: Kubernetes' own, and Ceph's in the storage ones. */
const MODELS: Record<string, string> = {
  "dtmi:osiris:k8s:Service": "svc",
  "dtmi:osiris:k8s:Ingress": "ing",
  "dtmi:osiris:k8s:Cluster": "control-plane",
  "dtmi:osiris:k8s:Node": "node",
  "dtmi:osiris:k8s:Namespace": "ns",
  "dtmi:osiris:k8s:Pod": "pod",
  "dtmi:osiris:k8s:PersistentVolumeClaim": "pvc",
  "dtmi:osiris:ceph:Cluster": "sc",
  "dtmi:osiris:ceph:Pool": "vol",
  "dtmi:osiris:ceph:Osd": "pv",
};

/** A twin's Kubernetes icon (outline SVG markup), or undefined for a model it has none for. */
export function iconOf(node: TwinView): string | undefined {
  if (node.icon && K8S_ICONS[node.icon]) return `<svg class="k8s-icon" viewBox="${K8S_ICONS[node.icon]!.viewBox}" aria-hidden="true">${K8S_ICONS[node.icon]!.body}</svg>`;
  const model = node.model.replace(/;.*$/, "");
  const icon =
    model === "dtmi:osiris:k8s:Container"
      ? CONTAINER
      : K8S_ICONS[model === "dtmi:osiris:k8s:Workload" ? (WORKLOADS[String(node.twin.ownerKind)] ?? "rs") : (MODELS[model] ?? "")];
  return icon ? `<svg class="k8s-icon" viewBox="${icon.viewBox}" aria-hidden="true">${icon.body}</svg>` : undefined;
}

/** What kind of thing a twin is, for people: a workload's owning kind (StatefulSet…), else its model's name. */
export const kindOf = (node: TwinView) => (typeof node.twin.ownerKind === "string" && node.twin.ownerKind ? node.twin.ownerKind : node.modelName);

/** A network interface's kind (card, router, tunnel, veth, LoadBalancer, public address). */
export const portKind = (node: TwinView) => String(node.twin.kind ?? "veth");
