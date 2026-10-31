import { spawn } from "node:child_process";
import { access, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cephReads, kubectlReads } from "@osiris/shared/ops.ts";

/**
 * Running the cluster's and Ceph's command-line tools for Osiris's agent (its `kubectl` and `ceph` tools), here in
 * the twin's service rather than in the agent's isolated runtime, read-only: only reads run (`kubectlReads`,
 * `cephReads`), kubectl with the `osiris-ops` ServiceAccount's token (view, no Secrets), ceph with the keyring of a
 * secret (a read-only key). This side also refuses what would change whose or which cluster the command talks to,
 * interactive sessions and runaway output. Commands are argument lists, never a shell.
 */
export interface OpsTools {
  kubectl?: { server: string; tokenPath: string; caPath: string };
  ceph?: { confPath: string; keyringPath: string; user: string };
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** The output was cut at the limit. */
  truncated: boolean;
  durationMs: number;
}

export class OpsRefused extends Error {}

const TIMEOUT_MS = 120_000;
const MAX_OUTPUT = 512 * 1024;

/** kubectl options that would change whose or which cluster the command talks to. */
const KUBECTL_IDENTITY = /^--?(kubeconfig|server|s|token|as|as-group|as-uid|user|cluster|context|certificate-authority|client-certificate|client-key|insecure-skip-tls-verify|tls-server-name|username|password)(=|$)/;
/** kubectl subcommands that need a terminal or open a tunnel. */
const KUBECTL_INTERACTIVE = new Set(["edit", "attach", "port-forward", "proxy", "debug", "completion", "plugin", "config", "alpha"]);
/** ceph options that would change whose or which cluster the command talks to. */
const CEPH_IDENTITY = /^--?(conf|c|keyring|k|keyfile|name|n|id|i|cluster|mon-host|m|admin-daemon)(=|$)/;

/** Checks a kubectl call: no identity or target of its own, nothing interactive (`exec` only without -i/-t). */
export function checkKubectl(args: string[]): void {
  const verb = args.find((a) => !a.startsWith("-"));
  if (!verb) throw new OpsRefused("kubectl needs a command");
  for (const a of args) if (KUBECTL_IDENTITY.test(a)) throw new OpsRefused(`kubectl option ${a.split("=")[0]} is not allowed: the twin's account is the one used`);
  if (KUBECTL_INTERACTIVE.has(verb)) throw new OpsRefused(`kubectl ${verb} is interactive or changes the configuration and isn't available`);
  if (verb === "exec" || verb === "run")
    for (const a of args) if (/^-(i|t|it|ti)$|^--(stdin|tty)(=true)?$/.test(a)) throw new OpsRefused(`kubectl ${verb} runs without a terminal: leave out ${a}`);
}

/** Checks a ceph call: no identity or cluster of its own. */
export function checkCeph(args: string[]): void {
  if (!args.length) throw new OpsRefused("ceph needs a command");
  for (const a of args) if (CEPH_IDENTITY.test(a)) throw new OpsRefused(`ceph option ${a.split("=")[0]} is not allowed: the configured admin is the one used`);
}

/** Runs a program with arguments (no shell), with a time limit and capped output. */
export function run(program: string, args: string[], stdin?: string, timeoutMs = TIMEOUT_MS): Promise<CommandResult> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: "/tmp" } });
    let stdout = "";
    let stderr = "";
    let truncated = false;
    const take = (current: string, chunk: Buffer) => {
      if (current.length >= MAX_OUTPUT) return ((truncated = true), current);
      const next = current + chunk.toString("utf8");
      if (next.length > MAX_OUTPUT) truncated = true;
      return next.slice(0, MAX_OUTPUT);
    };
    child.stdout.on("data", (c: Buffer) => (stdout = take(stdout, c)));
    child.stderr.on("data", (c: Buffer) => (stderr = take(stderr, c)));
    const timer = setTimeout(() => {
      stderr += `\n(stopped after ${Math.round(timeoutMs / 1000)} s)`;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("error", (err) => (clearTimeout(timer), reject(err)));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? -1, stdout, stderr, truncated, durationMs: Date.now() - start });
    });
    // A program that exits without reading its input closes the pipe: that's its business, not a crash of ours.
    child.stdin.on("error", () => {});
    child.stdin.end(stdin ?? "");
  });
}

/** The tools the service has: each only when its program and credentials are there. */
export async function availableTools(tools: OpsTools): Promise<{ kubectl: boolean; ceph: boolean }> {
  const exists = (path: string) => access(path).then(() => true, () => false);
  return {
    kubectl: !!tools.kubectl && (await exists(tools.kubectl.tokenPath)),
    ceph: !!tools.ceph && (await exists(tools.ceph.confPath)) && (await exists(tools.ceph.keyringPath)),
  };
}

let kubeconfigPath: string | undefined;
/**
 * A kubeconfig for the ops account, written once: the token stays in its file (`tokenFile`), never on a command line
 * where any process could read it.
 */
async function kubeconfigOf(k: NonNullable<OpsTools["kubectl"]>): Promise<string> {
  if (kubeconfigPath) return kubeconfigPath;
  const path = join(tmpdir(), `osiris-ops-${process.pid}.kubeconfig`);
  const config = {
    apiVersion: "v1",
    kind: "Config",
    clusters: [{ name: "cluster", cluster: { server: k.server, "certificate-authority": k.caPath } }],
    users: [{ name: "osiris-ops", user: { tokenFile: k.tokenPath } }],
    contexts: [{ name: "ops", context: { cluster: "cluster", user: "osiris-ops" } }],
    "current-context": "ops",
  };
  await writeFile(path, JSON.stringify(config), { mode: 0o600 });
  return (kubeconfigPath = path);
}

export async function kubectl(tools: OpsTools, args: string[], stdin?: string): Promise<CommandResult> {
  if (!tools.kubectl) throw new OpsRefused("kubectl is not set up for the twin");
  checkKubectl(args);
  if (!kubectlReads(args)) throw new OpsRefused("the agent's access is read-only: this kubectl command would change the cluster");
  return run("kubectl", [`--kubeconfig=${await kubeconfigOf(tools.kubectl)}`, "--request-timeout=60s", ...args], stdin);
}

export async function ceph(tools: OpsTools, args: string[], stdin?: string): Promise<CommandResult> {
  if (!tools.ceph) throw new OpsRefused("ceph is not set up for the twin");
  checkCeph(args);
  if (!cephReads(args)) throw new OpsRefused("the agent's access is read-only: this ceph command would change the storage");
  const c = tools.ceph;
  return run("ceph", [`--conf=${c.confPath}`, `--keyring=${c.keyringPath}`, `--name=${c.user}`, "--connect-timeout=20", ...args], stdin);
}
