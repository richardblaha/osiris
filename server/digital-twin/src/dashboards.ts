import type { Dashboard, DashboardPanel, InstanceData } from "./store.ts";

const HOUR = 3_600_000;
const panel = (id: string, kind: DashboardPanel["kind"], title: string, width: number, filter: Record<string, string>): DashboardPanel => ({ id, kind, title, width, filter });

/**
 * The dashboards the twin starts with: Osiris at a glance — its services' logs by level, their errors, their pods'
 * CPU, memory and network, the slow and failed traces, and its sign-in (osiris-auth) and project runtimes.
 */
export function defaultDashboards(now: number): Dashboard[] {
  return [
    {
      id: "osiris",
      name: "Osiris",
      range: 6 * HOUR,
      updatedAt: now,
      updatedBy: "Osiris Digital Twin",
      panels: [
        panel("logs-osiris", "logBars", "Osiris – logy podle úrovně", 4, { namespace: "osiris" }),
        panel("errors-osiris", "logs", "Osiris – chyby a varování", 2, { namespace: "osiris", severity: "warn" }),
        panel("traces-failed", "traces", "Osiris – trasy s chybou", 2, { namespace: "osiris", errors: "true" }),
        panel("cpu", "metric", "CPU podů Osirisu", 2, { metric: "k8s.pod.cpu.usage", type: "gauge", groupBy: "k8s.pod.name", namespace: "osiris" }),
        panel("memory", "metric", "Paměť podů Osirisu", 2, { metric: "k8s.pod.memory.working_set", type: "gauge", groupBy: "k8s.pod.name", unit: "By", namespace: "osiris" }),
        panel("network", "metric", "Síť podů Osirisu", 2, { metric: "k8s.pod.network.io", type: "sum", groupBy: "k8s.pod.name", unit: "By", namespace: "osiris" }),
        panel("traces-slow", "traces", "Osiris – pomalé trasy (> 1 s)", 2, { namespace: "osiris", minMs: "1000" }),
        panel("logs-auth", "logBars", "Přihlašování (osiris-auth)", 2, { namespace: "osiris-auth" }),
        panel("errors-auth", "logs", "osiris-auth – chyby", 2, { namespace: "osiris-auth", severity: "error" }),
      ],
    },
  ];
}

/** Creates the default dashboards once, in the instance of the cluster Osiris runs in (a deleted one stays deleted: the store remembers they were made). */
export async function seedDashboards(store: InstanceData, now = Date.now()): Promise<void> {
  for (const d of defaultDashboards(now)) {
    const key = `dashboard-seeded:${d.id}`;
    if (await store.meta(key)) continue;
    if (!(await store.dashboard(d.id))) await store.saveDashboard(d);
    await store.setMeta(key, String(now));
  }
}
