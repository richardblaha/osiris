import { cephReads } from "@osiris/shared/ops.ts";
import { commandTool, type OpsClient } from "@osiris/tools-ops";

export { cephReads };

export const cephTool = (client: OpsClient) =>
  commandTool(
    client,
    "ceph",
    cephReads,
    "Čtení stavu úložiště Ceph (microceph na uzlech clusteru) příkazem ceph, jen pro čtení. Argumenty jako pole, např. [\"status\"], [\"osd\", \"tree\"], [\"df\", \"detail\"], [\"osd\", \"pool\", \"ls\", \"detail\"]; " +
      "pro strojové zpracování přidej [\"--format\", \"json\"]. Jde status, health, df, osd tree/df/ls/perf, pg, mon, mgr, fs, config get/dump, crash ls/info. " +
      "Změny (osd out/in/reweight, pool create/set/delete, config set, mgr module enable, auth…) nejdou: navrhni je uživateli slovy, i s přesným příkazem. " +
      "Příkazy microceph se spouštějí na hostitelích, ne odsud.",
  );
