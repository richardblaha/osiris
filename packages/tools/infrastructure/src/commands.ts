/**
 * Which commands only read and which change something: reads run at once, changes wait for the user's yes. When in
 * doubt a command counts as a change.
 */

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

/** A command as people read it, for the question that asks to run it. */
export const commandLine = (program: string, args: string[]) =>
  [program, ...args.map((a) => (/^[\w./:=@,+-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`))].join(" ");
