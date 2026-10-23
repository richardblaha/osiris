import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
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

/** Where a running local agent tells its clients how to reach it. */
export interface AgentInfo {
  pid: number;
  port: number;
  url: string;
}

const HELP = `osiris [folder]   starts the Osiris agent over a project folder (default: the current one)

Options (or environment): --port <n> (OSIRIS_PORT, default 7777), --host <address> (OSIRIS_HOST, default 127.0.0.1)
Models and keys: environment, or ~/.config/osiris/agent.env (MISTRAL_API_KEY, LLM_MODEL, …)`;

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(HELP);
  process.exit(0);
}
const option = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const port = option("port");
const host = option("host");
const root = resolve(args[0] ?? process.cwd());
const name = basename(root);
const id = name.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "project";

const configDir = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "osiris");
const privateDir = join(root, ".osiris", "private");
const infoFile = join(privateDir, "agent.json");
mkdirSync(privateDir, { recursive: true, mode: 0o700 });

// One agent per folder: when one is running, its address is all we need.
const running = (() => {
  try {
    const info = JSON.parse(readFileSync(infoFile, "utf8")) as AgentInfo;
    process.kill(info.pid, 0);
    return info;
  } catch {
    return undefined;
  }
})();
if (running) {
  console.log(`Osiris already runs over ${root}: ${running.url}`);
  process.exit(0);
}

/** A file with a random secret, made once (0600). */
const secretFile = (file: string, bytes: number) => {
  if (!existsSync(file)) writeFileSync(file, randomBytes(bytes).toString("base64url"), { mode: 0o600 });
  return readFileSync(file, "utf8").trim();
};

mkdirSync(configDir, { recursive: true, mode: 0o700 });
if (existsSync(join(configDir, "agent.env"))) process.loadEnvFile(join(configDir, "agent.env"));
const here = import.meta.dirname;
const config = loadConfig({
  SKILLS_DIR: join(here, "../skills"),
  ...(existsSync(join(here, "../../osiris-pwa/dist")) ? { STATIC_DIR: join(here, "../../osiris-pwa/dist") } : {}),
  ...process.env,
  ...(port ? { OSIRIS_PORT: port } : {}),
  ...(host ? { OSIRIS_HOST: host } : {}),
});

// The user's own key seals each project's secrets with a key of its own (as the operator does in the cluster).
const master = Buffer.from(secretFile(join(configDir, "master.key"), 32), "base64url").toString("base64");
const token = secretFile(join(privateDir, "local-token"), 32);
const local = { token, user: localUser(), name };
const project = await buildProject(config, id, root, { features: new LocalFeatures(), secrets: new SecretBox(deriveProjectKey(master, id)) });
await project.init();

const agent = createRuntimeApp({
  project,
  local,
  activity: new Activity(),
  snapshot: async () => {
    throw new Error("A local agent has no backups: the project folder is yours (and git's).");
  },
});
const web = config.STATIC_DIR ? new Hono().use("*", serveStatic({ root: config.STATIC_DIR })).get("*", serveStatic({ root: config.STATIC_DIR, path: "index.html" })) : undefined;
const fetch = (req: Request) => {
  const path = new URL(req.url).pathname;
  return !web || path.startsWith("/api/") || path === "/health" ? agent.fetch(req) : web.fetch(req);
};

/** Listens on the port asked for; when the default one is taken, on any free one. */
const listen = (p: number) =>
  new Promise<number>((done, fail) => {
    const server = createAdaptorServer({ fetch });
    server.once("error", (err: NodeJS.ErrnoException) => (err.code === "EADDRINUSE" && !port && !process.env.OSIRIS_PORT && p !== 0 ? listen(0).then(done, fail) : fail(err)));
    server.listen(p, config.OSIRIS_HOST, () => {
      const address = server.address();
      done(typeof address === "object" && address ? address.port : p);
      process.on("SIGINT", () => server.close(() => process.exit(0)));
      process.on("SIGTERM", () => server.close(() => process.exit(0)));
    });
  });
const actual = await listen(config.OSIRIS_PORT);
const url = `http://${config.OSIRIS_HOST === "0.0.0.0" ? "127.0.0.1" : config.OSIRIS_HOST}:${actual}`;
writeFileSync(infoFile, JSON.stringify({ pid: process.pid, port: actual, url } satisfies AgentInfo), { mode: 0o600 });
process.on("exit", () => rmSync(infoFile, { force: true }));

console.log(`Osiris over ${root}`);
console.log(web ? `Open ${url}/#token=${token}` : `API at ${url}/api (token in .osiris/private/local-token)`);
