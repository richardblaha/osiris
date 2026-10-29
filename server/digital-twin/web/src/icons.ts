import { K8S_ICONS } from "./k8s-icons.ts";
import type { TwinView } from "./scene.ts";

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
/** The icon of each Kubernetes model, by the DTMI's last segment. */
const MODELS: Record<string, string> = { Cluster: "control-plane", Node: "node", Namespace: "ns", Pod: "pod", PersistentVolumeClaim: "pvc" };

/** A twin's Kubernetes icon (outline SVG markup), or undefined for a model it has none for. */
export function iconOf(node: TwinView): string | undefined {
  const kind = node.model.replace(/;.*$/, "").split(":").pop() ?? "";
  const icon = kind === "Container" ? CONTAINER : K8S_ICONS[kind === "Workload" ? (WORKLOADS[String(node.twin.ownerKind)] ?? "rs") : (MODELS[kind] ?? "")];
  return icon ? `<svg class="k8s-icon" viewBox="${icon.viewBox}" aria-hidden="true">${icon.body}</svg>` : undefined;
}

/** What kind of thing a twin is, for people: a workload's owning kind (StatefulSet…), else its model's name. */
export const kindOf = (node: TwinView) => (typeof node.twin.ownerKind === "string" && node.twin.ownerKind ? node.twin.ownerKind : node.modelName);
