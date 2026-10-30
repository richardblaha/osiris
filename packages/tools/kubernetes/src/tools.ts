import type { QuestionStore } from "@osiris/core/agent/questions.ts";
import { commandTool, type OpsClient } from "@osiris/tools-ops";

/** kubectl verbs that only read. */
const KUBECTL_READ = new Set(["get", "describe", "logs", "top", "explain", "api-resources", "api-versions", "version", "cluster-info", "events", "wait", "diff"]);

/** Whether a kubectl call only reads (`auth can-i`, `rollout status|history`, a dry run count as reads). */
export function kubectlReads(args: string[]): boolean {
  const words = args.filter((a) => !a.startsWith("-"));
  const [verb, sub] = words;
  if (!verb) return false;
  if (args.some((a) => /^--dry-run(=(client|server))?$/.test(a))) return true;
  if (KUBECTL_READ.has(verb)) return verb !== "cluster-info" || sub !== "dump";
  if (verb === "auth") return sub === "can-i" || sub === "whoami";
  if (verb === "rollout") return sub === "status" || sub === "history";
  return false;
}

export const kubectlTool = (client: OpsClient, questions: QuestionStore) =>
  commandTool(
    client,
    questions,
    "kubectl",
    kubectlReads,
    "Správa Kubernetes clusteru (busiris) příkazem kubectl jako administrátor. Argumenty předej jako pole, např. [\"get\", \"pods\", \"-A\", \"-o\", \"wide\"]; " +
      "API přímo: [\"get\", \"--raw\", \"/apis\"]. Čtení (get, describe, logs, top, events, explain, auth can-i, rollout status, --dry-run) proběhne hned. " +
      "Každá změna (apply, create, delete, patch, scale, rollout restart, cordon, drain, label, exec…) se nejdřív zeptá uživatele; když odpoví, zavolej nástroj znovu se stejnými argumenty. " +
      "YAML pro apply předej ve stdin s argumenty [\"apply\", \"-f\", \"-\"]. Nejde: edit, port-forward, proxy, exec -it, vlastní --kubeconfig/--as. " +
      "Cluster je microk8s (kubeadm se v něm nepoužívá; uzly a jejich upgrade spravuje microk8s na hostitelích).",
  );
