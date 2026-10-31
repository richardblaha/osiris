import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

/** Where a running local agent tells its clients how to reach it (`.osiris/private/agent.json`). */
export interface AgentInfo {
  /** The process clients watch: the agent's, or the launcher's that runs it in a container. */
  pid: number;
  port: number;
  url: string;
  /** The agent runs in a container (`osiris-agent-<project>`). */
  container?: string;
}

/** A local project's id: its folder's name, lowercase ASCII with hyphens. */
export const projectIdOf = (root: string) =>
  basename(root).toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "project";

/** The user's Osiris settings: `agent.env` (models, keys), `master.key`. */
export const configDir = () => join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "osiris");

/** The files a local agent keeps in its project's `.osiris/private/`. */
export function agentFiles(root: string) {
  const privateDir = join(root, ".osiris", "private");
  return {
    privateDir,
    info: join(privateDir, "agent.json"),
    /** Why the agent couldn't start, for the clients that started it (the desktop app, VS Code, osiris-cli) to show. */
    error: join(privateDir, "agent-error"),
    lock: join(privateDir, "agent.lock"),
    token: join(privateDir, "local-token"),
  };
}

/** The agent already running over the folder, when its address answers. */
export async function runningAgent(infoFile: string): Promise<AgentInfo | undefined> {
  try {
    const info = JSON.parse(readFileSync(infoFile, "utf8")) as AgentInfo;
    return (await fetch(`${info.url}/health`, { signal: AbortSignal.timeout(2000) })).ok ? info : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Takes the folder's start lock (`wx`): one agent per folder, as records are locked only within one process. A lock
 * older than any start (2 minutes) is a crash's and is taken over. False when another start holds it.
 */
export function takeLock(lockFile: string): boolean {
  const lock = () => {
    try {
      writeFileSync(lockFile, String(process.pid), { flag: "wx", mode: 0o600 });
      return true;
    } catch {
      return false;
    }
  };
  if (lock()) return true;
  const stale = Date.now() - statSync(lockFile).mtimeMs > 120_000;
  return stale && (rmSync(lockFile, { force: true }), lock());
}

/** A file with a random secret, made once (0600). */
export function secretFile(file: string, bytes: number): string {
  if (!existsSync(file)) writeFileSync(file, randomBytes(bytes).toString("base64url"), { mode: 0o600 });
  return readFileSync(file, "utf8").trim();
}

/** The user's master key (made once), base64 — each project's secrets key is derived from it. */
export function masterKey(): string {
  const dir = configDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return Buffer.from(secretFile(join(dir, "master.key"), 32), "base64url").toString("base64");
}
