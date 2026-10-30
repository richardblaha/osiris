import type { QuestionStore } from "@osiris/core/agent/questions.ts";
import { commandTool, type OpsClient } from "@osiris/tools-ops";

/** ceph commands that only read, as their leading words. `auth` (it shows keys) and the rest count as changes. */
const CEPH_READ = [
  "status", "-s", "health", "df", "versions", "version", "report", "quorum_status", "time-sync-status", "features", "fsid",
  "osd tree", "osd df", "osd ls", "osd stat", "osd dump", "osd perf", "osd find", "osd metadata", "osd utilization", "osd pool ls", "osd pool stats", "osd pool get",
  "osd pool autoscale-status", "osd crush tree", "osd crush rule ls", "osd crush rule dump", "osd blocked-by", "osd ok-to-stop", "osd safe-to-destroy",
  "pg stat", "pg dump", "pg ls", "pg dump_stuck", "mon stat", "mon dump", "mgr stat", "mgr services", "mgr module ls", "mgr dump",
  "fs ls", "fs status", "fs dump", "mds stat", "config get", "config dump", "config show", "config-key ls", "crash ls", "crash info", "crash stat",
  "log last", "balancer status", "balancer eval", "orch ls", "orch ps", "orch status", "orch host ls", "orch device ls", "device ls", "telemetry status", "progress",
];

export function cephReads(args: string[]): boolean {
  const line = args.filter((a) => !a.startsWith("--format") && !/^(json|json-pretty|plain|xml)$/.test(a)).join(" ");
  return CEPH_READ.some((r) => line === r || line.startsWith(`${r} `));
}

export const cephTool = (client: OpsClient, questions: QuestionStore) =>
  commandTool(
    client,
    questions,
    "ceph",
    cephReads,
    "Správa úložiště Ceph (microceph na uzlech clusteru) příkazem ceph jako client.admin. Argumenty jako pole, např. [\"status\"], [\"osd\", \"tree\"], [\"df\", \"detail\"], [\"osd\", \"pool\", \"ls\", \"detail\"]; " +
      "pro strojové zpracování přidej [\"--format\", \"json\"]. Čtení (status, health, df, osd tree/df/ls, pg, mon, mgr, fs, config get…) proběhne hned; " +
      "každá změna (osd out/in/reweight, pool create/set/delete, config set, mgr module enable, auth…) se nejdřív zeptá uživatele; po odpovědi zavolej nástroj znovu se stejnými argumenty. " +
      "Příkazy microceph (správa uzlů a disků microcephu) se spouštějí na hostitelích, ne odsud.",
  );
