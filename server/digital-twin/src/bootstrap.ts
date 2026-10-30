import { readFile } from "node:fs/promises";
import type { Config } from "./config.ts";
import { seedDashboards } from "./dashboards.ts";
import type { TwinStore } from "./store.ts";

const BOOTSTRAPPED = "instances.bootstrapped";

/**
 * The first start with no instances makes one: the Kubernetes cluster of the service's settings (KUBECONFIG and
 * KUBE_CONTEXT, else the cluster it runs in), with CEPH_MANAGERS and CLICKHOUSE_CLUSTER, named and identified by
 * CLUSTER_NAME, so the history it wrote as the one twin (`twin.id`) goes on. It takes over the one twin's
 * dashboards and saved filters and gets Osiris's dashboard. Only once: an admin who deletes it keeps it deleted.
 */
export async function bootstrapInstance(store: TwinStore, config: Config, now = Date.now()): Promise<void> {
  const meta = store.of("");
  if (await meta.meta(BOOTSTRAPPED)) return;
  if (!(await store.instances()).length) {
    const id = config.CLUSTER_NAME;
    const kubeconfig = config.KUBECONFIG ? await readFile(config.KUBECONFIG.split(":").find(Boolean)!, "utf8") : undefined;
    await store.putInstance(
      {
        id,
        name: id,
        sourceType: "kubernetes",
        settings: {
          connection: kubeconfig ? "kubeconfig" : "inCluster",
          context: config.KUBE_CONTEXT ?? "",
          clusterName: id,
          cephManagers: config.CEPH_MANAGERS.join(","),
          clickhouseUrl: "",
          clickhouseUser: "",
          clickhouseCluster: config.CLICKHOUSE_CLUSTER ?? "",
        },
        secrets: kubeconfig ? { kubeconfig } : {},
      },
      now,
    );
    await store.claimLegacy(id);
    await seedDashboards(store.of(id), now);
  }
  await meta.setMeta(BOOTSTRAPPED, String(now));
}
