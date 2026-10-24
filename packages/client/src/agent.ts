import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// The local agent from Node clients (the TUI, the VS Code extension): which folder is the project, whether its agent
// runs, and starting one.

/** What a running agent writes to `.osiris/private/agent.json`. */
export interface AgentInfo {
  pid: number;
  port: number;
  url: string;
}

/** The project folder: the nearest one up from `dir` that has `.osiris/`, else `dir` itself (a new project). */
export function projectRoot(dir: string): string {
  for (let d = resolve(dir); ; d = dirname(d)) {
    if (existsSync(join(d, ".osiris"))) return d;
    if (dirname(d) === d) return resolve(dir);
  }
}

/** The agent running over `root`, if one is. */
export function runningAgent(root: string): AgentInfo | undefined {
  try {
    const info = JSON.parse(readFileSync(join(root, ".osiris/private/agent.json"), "utf8")) as AgentInfo;
    process.kill(info.pid, 0);
    return info;
  } catch {
    return undefined;
  }
}

/**
 * The agent over `root` with its token: the one running there, else a new one started with `command` in the background
 * (it outlives the client, like a server, and the next client finds it).
 */
export async function localAgent(root: string, command: string[], { log = () => {}, args = [] }: { log?: (line: string) => void; args?: string[] } = {}): Promise<AgentInfo & { token: string }> {
  let info = runningAgent(root);
  if (!info) {
    const errorFile = join(root, ".osiris/private/agent-error");
    rmSync(errorFile, { force: true });
    log(`Starting Osiris over ${root}…`);
    const child = spawn(command[0]!, [...command.slice(1), root, ...args], { detached: true, stdio: "ignore", env: process.env });
    child.on("error", (err) => log(`Osiris didn't start: ${err.message}`));
    child.unref();
    for (let i = 0; i < 240 && !info; i++) {
      await new Promise((r) => setTimeout(r, 250));
      info = runningAgent(root);
      // The agent says why it couldn't start (a missing model key, …).
      if (!info && existsSync(errorFile)) throw new Error(`Osiris didn't start: ${readFileSync(errorFile, "utf8").trim()}`);
    }
    if (!info) throw new Error(`Osiris didn't start over ${root} (run \`osiris ${root}\` to see why).`);
  }
  return { ...info, token: readFileSync(join(root, ".osiris/private/local-token"), "utf8").trim() };
}
