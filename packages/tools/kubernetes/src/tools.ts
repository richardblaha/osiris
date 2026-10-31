import { kubectlReads } from "@osiris/shared/ops.ts";
import { commandTool, type OpsClient } from "@osiris/tools-ops";

export { kubectlReads };

export const kubectlTool = (client: OpsClient) =>
  commandTool(
    client,
    "kubectl",
    kubectlReads,
    "Čtení stavu Kubernetes clusteru (busiris) příkazem kubectl, jen pro čtení (role view: bez Secrets). Argumenty předej jako pole, např. [\"get\", \"pods\", \"-A\", \"-o\", \"wide\"]; " +
      "API přímo: [\"get\", \"--raw\", \"/apis\"]. Jde get, describe, logs, top, events, explain, api-resources, auth can-i, rollout status/history. " +
      "Změny (apply, create, delete, patch, scale, rollout restart, cordon, drain, label, exec…) nejdou: navrhni je uživateli slovy, i s přesným příkazem. " +
      "Nejde ani edit, port-forward, proxy, vlastní --kubeconfig/--as. Cluster je microk8s (uzly a jejich upgrade spravuje microk8s na hostitelích).",
  );
