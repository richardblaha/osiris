import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { userInfo } from "node:os";
import { basename, join, resolve } from "node:path";
import { parseEnv } from "node:util";
import { deriveProjectKey } from "@osiris/platform/project-keys.ts";
import { agentFiles, configDir, masterKey, projectIdOf, runningAgent, takeLock } from "./local-files.ts";

/**
 * The `osiris` command. By default the agent runs in a container: only the project folder mounted, a read-only
 * system, no capabilities, limited memory and processes, as the user's own uid, on an internal network whose one way
 * out is the gate container (`gate.ts`: an egress proxy to public addresses only, and the agent's port forwarded from
 * the host's 127.0.0.1). The container gets the project's derived secrets key, never the user's master key.
 * `--no-container` (or a run inside a container already: a devcontainer, Codespaces) runs the agent as a process.
 */

const AGENT_PORT = 7777;
const PROXY_PORT = 3128;

export interface ContainerPlanInput {
  /** The container CLI (`docker`, or `podman`). */
  cli: string;
  image: string;
  root: string;
  projectId: string;
  projectName: string;
  hostPort: number;
  uid: number;
  gid: number;
  user: { login: string; name?: string | null; email?: string | null };
  launcherPid: number;
  /** Names of environment variables the agent gets from the launcher's environment (their values never on the command line). */
  secretEnv: string[];
  /** Egress exceptions, `host[:port]`. */
  egressAllow: string[];
  memory?: string;
}

/** Container names of a folder: its project id and a short hash of its path, so two folders of one name never meet. */
export function containerKey(root: string, projectId: string) {
  return `${projectId}-${createHash("sha256").update(root).digest("hex").slice(0, 8)}`;
}

/** The container CLI's commands that start a contained agent, in order (the last one runs in the foreground). */
export function containerPlan(p: ContainerPlanInput) {
  const key = containerKey(p.root, p.projectId);
  const names = { network: `osiris-${key}`, gate: `osiris-gate-${key}`, agent: `osiris-agent-${key}` };
  const label = ["--label", `osiris.project=${key}`];
  const hardened = ["--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges"];
  const env = (name: string, value?: string | number | null) => ["-e", value === undefined ? name : `${name}=${value ?? ""}`];
  const proxy = `http://gate:${PROXY_PORT}`;
  const podman = basename(p.cli) === "podman";
  return {
    names,
    network: [p.cli, "network", "create", "--internal", ...label, names.network],
    gate: [
      p.cli, "run", "-d", "--rm", "--name", names.gate, ...label, ...hardened,
      "--memory", "128m", "--pids-limit", "64", "--user", "65534:65534", "--tmpfs", "/tmp:rw,nosuid,nodev,size=32m",
      // The host is reachable only as an exception (OSIRIS_EGRESS_ALLOW=host.docker.internal:11434, e.g. a local model server).
      "--add-host", "host.docker.internal:host-gateway",
      "-p", `127.0.0.1:${p.hostPort}:${AGENT_PORT}`,
      ...env("GATE_AGENT", `${names.agent}:${AGENT_PORT}`), ...env("GATE_LISTEN_PORT", AGENT_PORT), ...env("GATE_PROXY_PORT", PROXY_PORT),
      ...env("OSIRIS_EGRESS_ALLOW", p.egressAllow.join(",")),
      p.image, "node_modules/.bin/tsx", "src/gate-cli.ts",
    ],
    connectGate: [p.cli, "network", "connect", "--alias", "gate", names.network, names.gate],
    agent: [
      p.cli, "run", "--rm", "--name", names.agent, ...label, ...hardened,
      "--network", names.network, "--memory", p.memory ?? "2g", "--pids-limit", "512",
      "--tmpfs", "/tmp:rw,nosuid,nodev,size=512m",
      "--user", `${p.uid}:${p.gid}`, ...(podman ? ["--userns", "keep-id"] : []),
      "-v", `${p.root}:/project`,
      ...env("HOME", "/tmp"), ...env("OSIRIS_CONTAINED", 1), ...env("OSIRIS_PROJECT_ID", p.projectId), ...env("OSIRIS_PROJECT_NAME", p.projectName),
      ...env("OSIRIS_HOST", "0.0.0.0"), ...env("OSIRIS_PORT", AGENT_PORT), ...env("OSIRIS_PUBLIC_URL", `http://127.0.0.1:${p.hostPort}`),
      ...env("OSIRIS_LAUNCHER_PID", p.launcherPid), ...env("OSIRIS_CONTAINER_NAME", names.agent),
      ...env("OSIRIS_USER_LOGIN", p.user.login), ...env("OSIRIS_USER_NAME", p.user.name), ...env("OSIRIS_USER_EMAIL", p.user.email),
      ...env("NODE_USE_ENV_PROXY", 1), ...env("HTTPS_PROXY", proxy), ...env("OSIRIS_EGRESS_PROXY", proxy),
      ...p.secretEnv.flatMap((name) => env(name)),
      p.image, "node_modules/.bin/tsx", "src/cli.ts", "/project",
    ],
    /** Removes what a crashed run left (containers by label, then the network). */
    cleanup: [
      [p.cli, "rm", "-f", names.agent, names.gate],
      [p.cli, "network", "rm", names.network],
    ],
  };
}

/** Already in a container (a devcontainer, Codespaces, the image itself): another one inside would need the host's socket. */
export function insideContainer(env = process.env, exists = existsSync) {
  return exists("/.dockerenv") || exists("/run/.containerenv") || !!env.REMOTE_CONTAINERS || !!env.CODESPACES || env.OSIRIS_CONTAINED === "1";
}

/** Settings for the agent from `~/.config/osiris/agent.env` (passed by name; values only in the launcher's environment). */
function agentEnv(): Record<string, string> {
  const file = join(configDir(), "agent.env");
  return existsSync(file) ? (parseEnv(readFileSync(file, "utf8")) as Record<string, string>) : {};
}

/** Settings of the agent's own the user set in the environment (they win over agent.env, as for a process). */
const PASSED = /^(MISTRAL_|OPENAI_|ANTHROPIC_|GOOGLE_|GROQ_|LLM_|EMBEDDING_|COMFY_|IMAGE_|MEMORY_|TOOL_MODULES$|GOOGLE_INTEGRATION_|MICROSOFT_INTEGRATION_|FILES_|MCP_ALLOW_PRIVATE$|DEFAULT_LOCALE$|TZ$)/;

const free = (port: number) =>
  new Promise<number>((done, fail) => {
    const s = createServer();
    s.once("error", fail);
    s.listen(port, "127.0.0.1", () => {
      const a = s.address();
      s.close(() => done(typeof a === "object" && a ? a.port : port));
    });
  });

const git = (key: string) => {
  const r = spawnSync("git", ["config", "--get", key], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() || null : null;
};

/** Runs the container CLI; throws with its output when it fails. */
function run(cmd: string[], env?: NodeJS.ProcessEnv) {
  const r = spawnSync(cmd[0]!, cmd.slice(1), { encoding: "utf8", env });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${cmd.slice(0, 3).join(" ")} failed: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout.trim();
}

export async function launch(argv: string[]) {
  const args = [...argv];
  const flag = (name: string) => (args.includes(`--${name}`) ? (args.splice(args.indexOf(`--${name}`), 1), true) : false);
  const option = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args.splice(i, 2)[1] : undefined;
  };
  if (args.includes("--help") || args.includes("-h") || flag("no-container") || process.env.OSIRIS_CONTAINER === "0" || insideContainer()) {
    if (insideContainer() && !argv.includes("--no-container") && !argv.includes("--help")) console.log("Osiris runs in a container already: the agent starts as a process.");
    return import("./cli.ts");
  }
  const build = flag("build-image");
  const imageArg = option("image");
  const portArg = option("port") ?? process.env.OSIRIS_PORT;
  if (option("host")) console.warn("--host is ignored: a contained agent listens on the host's 127.0.0.1 only.");
  const root = resolve(args[0] ?? process.cwd());
  const projectId = projectIdOf(root);
  const files = agentFiles(root);
  mkdirSync(files.privateDir, { recursive: true, mode: 0o700 });
  rmSync(files.error, { force: true });
  const fail = (message: string): never => {
    writeFileSync(files.error, message, { mode: 0o600 });
    console.error(`Osiris didn't start: ${message}`);
    process.exit(1);
  };

  const running = await runningAgent(files.info);
  if (running) return console.log(`Osiris already runs over ${root}: ${running.url}`);
  if (!takeLock(files.lock)) return console.log(`Osiris is starting over ${root} already.`);
  process.on("exit", () => rmSync(files.lock, { force: true }));

  const cli = process.env.OSIRIS_CONTAINER_CLI ?? "docker";
  const probe = spawnSync(cli, ["version", "--format", "{{.Server.Version}}"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) {
    fail(`${cli} isn't available (${(probe.stderr || probe.error?.message || "").trim() || "no answer"}). Osiris runs the agent in a container: install Docker (or set OSIRIS_CONTAINER_CLI=podman), or start it as a process with --no-container.`);
  }

  const here = import.meta.dirname;
  // The .deb's wrapper sets OSIRIS_IMAGE to its own release's image; from the repository, main's.
  let image = imageArg ?? process.env.OSIRIS_IMAGE ?? "ghcr.io/richardblaha/osiris-local:main";
  try {
    if (build) {
      const repo = resolve(here, "../../..");
      if (!existsSync(join(repo, "Dockerfile"))) fail("--build-image needs the Osiris repository (its Dockerfile).");
      image = imageArg ?? "osiris-local:dev";
      console.log(`Building ${image}…`);
      const b = spawnSync(cli, ["build", "--target", "local", "-t", image, repo], { stdio: "inherit" });
      if (b.status !== 0) fail(`${cli} build failed.`);
    } else if (spawnSync(cli, ["image", "inspect", image], { stdio: "ignore" }).status !== 0) {
      console.log(`Pulling ${image}…`);
      const pull = spawnSync(cli, ["pull", image], { stdio: "inherit" });
      if (pull.status !== 0) fail(`${cli} pull ${image} failed. Build it from the repository with --build-image, or name another with --image.`);
    }
  } catch (err) {
    fail((err as Error).message);
  }

  const settings = { ...agentEnv(), ...Object.fromEntries(Object.entries(process.env).filter(([k, v]) => PASSED.test(k) && v !== undefined)) } as Record<string, string>;
  const projectKey = deriveProjectKey(masterKey(), projectId);
  const hostPort = await free(portArg ? Number(portArg) : AGENT_PORT).catch(() => (portArg ? fail(`Port ${portArg} is taken.`) : free(0)));
  const login = userInfo().username;
  const plan = containerPlan({
    cli,
    image,
    root,
    projectId,
    projectName: basename(root),
    hostPort,
    uid: process.getuid?.() ?? 1000,
    gid: process.getgid?.() ?? 1000,
    user: { login, name: git("user.name"), email: git("user.email") },
    launcherPid: process.pid,
    secretEnv: ["OSIRIS_PROJECT_KEY", ...Object.keys(settings)],
    egressAllow: (process.env.OSIRIS_EGRESS_ALLOW ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    memory: process.env.OSIRIS_MEMORY,
  });
  const cleanup = () => plan.cleanup.forEach((cmd) => spawnSync(cmd[0]!, cmd.slice(1), { stdio: "ignore" }));
  cleanup();
  try {
    run(plan.network);
    run(plan.gate);
    run(plan.connectGate);
  } catch (err) {
    cleanup();
    fail((err as Error).message);
  }

  console.log(`Osiris over ${root}, in container ${plan.names.agent} (egress through ${plan.names.gate})`);
  const agent = spawn(plan.agent[0]!, plan.agent.slice(1), { stdio: "inherit", env: { ...process.env, ...settings, OSIRIS_PROJECT_KEY: projectKey } });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    spawnSync(cli, ["stop", "-t", "10", plan.names.agent], { stdio: "ignore" });
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  process.on("SIGHUP", stop);
  agent.on("exit", (code) => {
    cleanup();
    rmSync(files.info, { force: true });
    // 125–127: the container never started (the agent itself writes agent-error for its own failures).
    if (!stopping && code !== null && code >= 125 && code <= 127 && !existsSync(files.error)) {
      writeFileSync(files.error, `The agent's container didn't start (${cli} exit ${code}).`, { mode: 0o600 });
    }
    process.exit(stopping ? 0 : (code ?? 1));
  });
}
