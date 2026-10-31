import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { createAdaptorServer } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { SecretBox } from "@osiris/core/secrets.ts";
import { deriveProjectKey } from "@osiris/platform/project-keys.ts";
import { Activity } from "./activity.ts";
import { createRuntimeApp } from "./app.ts";
import { buildProject } from "./build.ts";
import { loadConfig } from "./config.ts";
import { LocalFeatures, localUser } from "./local.ts";
import { agentFiles, configDir as userConfigDir, masterKey, projectIdOf, runningAgent, secretFile, takeLock, type AgentInfo } from "./local-files.ts";

/**
 * The agent over a project folder, as a process. Run by the `osiris` command either in a container (`launcher.ts`,
 * `OSIRIS_CONTAINED=1`: the launcher holds the folder's lock and passes the project's derived key, its address on the
 * host and the user) or directly (`--no-container`).
 */
const HELP = `osiris [folder]   starts the Osiris agent over a project folder (default: the current one), in a container

Options (or environment): --port <n> (OSIRIS_PORT, default 7777), --host <address> (OSIRIS_HOST, default 127.0.0.1),
  --no-container (OSIRIS_CONTAINER=0: run as a process of this user), --image <name> (OSIRIS_IMAGE), --build-image
Models and keys: environment, or ~/.config/osiris/agent.env (MISTRAL_API_KEY, LLM_MODEL, …)
Egress exceptions (contained): OSIRIS_EGRESS_ALLOW=host[:port],…`;

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(HELP);
  process.exit(0);
}
const option = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
for (const flag of ["--no-container", "--build-image"]) if (args.includes(flag)) args.splice(args.indexOf(flag), 1);
option("image");
const contained = process.env.OSIRIS_CONTAINED === "1";
const port = option("port");
const host = option("host");
const root = resolve(args[0] ?? process.cwd());
const id = process.env.OSIRIS_PROJECT_ID || projectIdOf(root);

const configDir = userConfigDir();
const files = agentFiles(root);
const { privateDir, info: infoFile, error: errorFile, lock: lockFile } = files;
mkdirSync(privateDir, { recursive: true, mode: 0o700 });
rmSync(errorFile, { force: true });
const fail = (err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  const hint = /API key|api.?key/i.test(message) ? ` Set it in ${join(configDir, "agent.env")} (e.g. MISTRAL_API_KEY=…).` : "";
  writeFileSync(errorFile, `${message}${hint}`, { mode: 0o600 });
  console.error(`Osiris didn't start: ${message}${hint}`);
  process.exit(1);
};
process.on("uncaughtException", fail);
process.on("unhandledRejection", fail);

// One agent per folder: a running one's address is all we need, and a second start while one is still starting
// (models, indexes: seconds) must not run beside it, as records are locked only within one process. A contained
// agent's launcher has checked and holds the lock.
if (!contained) {
  const running = await runningAgent(infoFile);
  if (running) {
    console.log(`Osiris already runs over ${root}: ${running.url}`);
    process.exit(0);
  }
  if (!takeLock(lockFile)) {
    console.log(`Osiris is starting over ${root} already.`);
    process.exit(0);
  }
}
process.on("exit", () => {
  rmSync(infoFile, { force: true });
  if (!contained) rmSync(lockFile, { force: true });
});

// A contained agent gets its settings from the launcher (the container has no home of the user's).
if (!contained && existsSync(join(configDir, "agent.env"))) process.loadEnvFile(join(configDir, "agent.env"));
const here = import.meta.dirname;
const config = loadConfig({
  SKILLS_DIR: join(here, "../skills"),
  ...(existsSync(join(here, "../../osiris-pwa/dist")) ? { STATIC_DIR: join(here, "../../osiris-pwa/dist") } : {}),
  ...process.env,
  ...(port ? { OSIRIS_PORT: port } : {}),
  ...(host ? { OSIRIS_HOST: host } : {}),
});

// The user's own key seals each project's secrets with a key of its own (as the operator does in the cluster); a
// contained agent gets only its project's derived key, never the master key of all the user's projects.
const projectKey = contained ? process.env.OSIRIS_PROJECT_KEY : deriveProjectKey(masterKey(), id);
if (!projectKey) throw new Error("OSIRIS_PROJECT_KEY is missing");
delete process.env.OSIRIS_PROJECT_KEY;
const token = secretFile(files.token, 32);
// In a container the folder is /project: its own name comes from the launcher.
const local = { token, user: localUser(), name: process.env.OSIRIS_PROJECT_NAME || basename(root) };
const web = config.STATIC_DIR ? new Hono().use("*", serveStatic({ root: config.STATIC_DIR })).get("*", serveStatic({ root: config.STATIC_DIR, path: "index.html" })) : undefined;
// The address is known only once listening, and the project needs it (OAuth sign-ins come back to <PUBLIC_URL>/…):
// requests wait for the app, and clients find the agent only after agent.json, written when it's ready.
let ready!: (app: { fetch: (req: Request) => Response | Promise<Response> }) => void;
const app = new Promise<{ fetch: (req: Request) => Response | Promise<Response> }>((r) => (ready = r));
const handle = async (req: Request) => {
  const path = new URL(req.url).pathname;
  return !web || path.startsWith("/api/") || path === "/health" ? (await app).fetch(req) : web.fetch(req);
};

/** Listens on the port asked for; when the default one is taken, on any free one. */
const listen = (p: number) =>
  new Promise<number>((done, fail) => {
    const server = createAdaptorServer({ fetch: handle });
    server.once("error", (err: NodeJS.ErrnoException) => (err.code === "EADDRINUSE" && !port && !process.env.OSIRIS_PORT && p !== 0 ? listen(0).then(done, fail) : fail(err)));
    server.listen(p, config.OSIRIS_HOST, () => {
      const address = server.address();
      done(typeof address === "object" && address ? address.port : p);
      process.on("SIGINT", () => server.close(() => process.exit(0)));
      process.on("SIGTERM", () => server.close(() => process.exit(0)));
    });
  });
const actual = await listen(config.OSIRIS_PORT);
// A contained agent listens in its container; clients reach it at the address the launcher published on the host.
const url = contained && process.env.OSIRIS_PUBLIC_URL ? process.env.OSIRIS_PUBLIC_URL : `http://${config.OSIRIS_HOST === "0.0.0.0" ? "127.0.0.1" : config.OSIRIS_HOST}:${actual}`;

const project = await buildProject({ ...config, PUBLIC_URL: url }, id, root, { features: new LocalFeatures(), secrets: new SecretBox(projectKey) });
await project.init();
ready(
  createRuntimeApp({
    project,
    local,
    activity: new Activity(),
    snapshot: async () => {
      throw new Error("A local agent has no backups: the project folder is yours (and git's).");
    },
  }),
);
const info: AgentInfo = contained
  ? { pid: Number(process.env.OSIRIS_LAUNCHER_PID), port: Number(new URL(url).port), url, container: process.env.OSIRIS_CONTAINER_NAME }
  : { pid: process.pid, port: actual, url };
writeFileSync(infoFile, JSON.stringify(info), { mode: 0o600 });

console.log(`Osiris over ${root}`);
console.log(web ? `Open ${url}/#token=${token}` : `API at ${url}/api (token in .osiris/private/local-token)`);
