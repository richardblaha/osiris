import { fork } from "node:child_process";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tool, type StructuredToolInterface } from "@langchain/core/tools";
import type { JsonSchema7Type } from "@langchain/core/utils/json_schema";
import { getRunContext } from "../../agent/context.ts";
import { fetchWithSecrets, type SecretRequest, type SecretResponse } from "../../vault/fetch.ts";
import type { SecretVault } from "../../vault/vault.ts";

/** The project's own tools: `.osiris/tools/<name>.ts` (or `.mts`, `.js`, `.mjs`); helpers may sit in subfolders. */
export const CUSTOM_TOOLS_DIR = "tools";

const RUNNER = fileURLToPath(new URL("./runner.mjs", import.meta.url));
const EXTENSIONS = [".ts", ".mts", ".js", ".mjs"];
/** Like a built-in tool's name: what models accept, and never a hidden or odd file name. */
export const CUSTOM_TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;

const DESCRIBE_MS = 5_000;
const RUN_MS = 30_000;
const MAX_RESULT_CHARS = 20_000;
const MAX_FETCHES = 20;
const MAX_FETCH_CHARS = 1_000_000;

export interface CustomToolOptions {
  /** Development only: `ctx.fetch` may reach http and private addresses. */
  allowPrivate?: boolean;
  fetch?: typeof fetch;
  runMs?: number;
}

/** One file of `.osiris/tools/`: its tool, or why it has none. */
export interface CustomToolEntry {
  name: string;
  file: string;
  tool?: StructuredToolInterface;
  error?: string;
}

interface Described {
  description: string;
  input: JsonSchema7Type;
}

/**
 * The project's own tools. Each file's description and input schema are read once (in a sandboxed process, like a
 * call) and again whenever the file changes; every call runs in a fresh process. The folder is under `.osiris/`, which
 * neither the file API nor the agent's file tools reach, so the agent can't write its own code: they come from the
 * project folder itself (the repository, or the computer of a local agent).
 */
export class CustomTools {
  private readonly cache = new Map<string, { key: string; entry: CustomToolEntry }>();

  constructor(
    /** The project's `.osiris/` folder. */
    private readonly osirisDir: string,
    private readonly vault: SecretVault,
    private readonly options: CustomToolOptions = {},
  ) {}

  get dir() {
    return join(this.osirisDir, CUSTOM_TOOLS_DIR);
  }

  /** Every tool file with its tool or its problem, by name. `reserved` are the names taken (built-in tools). */
  async list(reserved: ReadonlySet<string>): Promise<CustomToolEntry[]> {
    const dir = this.dir;
    const stat = await lstat(dir).catch(() => undefined);
    if (!stat?.isDirectory()) return [];
    const files = (await readdir(dir, { withFileTypes: true }))
      .filter((e) => !e.name.startsWith(".") && EXTENSIONS.some((x) => e.name.endsWith(x)))
      .sort((a, b) => a.name.localeCompare(b.name));
    const seen = new Set<string>();
    const out: CustomToolEntry[] = [];
    for (const e of files) {
      const name = e.name.slice(0, e.name.lastIndexOf("."));
      const file = join(dir, e.name);
      const fail = (error: string) => out.push({ name, file, error });
      if (!e.isFile()) fail("not a regular file (links are not followed)");
      else if (!CUSTOM_TOOL_NAME.test(name)) fail("the name must be lowercase letters, digits and _, starting with a letter");
      else if (reserved.has(name)) fail(`a built-in tool is named ${name}`);
      else if (seen.has(name)) fail(`another file is named ${name} too`);
      else out.push(await this.entry(name, file));
      seen.add(name);
    }
    for (const name of this.cache.keys()) if (!out.some((t) => t.file === name)) this.cache.delete(name);
    return out;
  }

  /** The usable tools. */
  async tools(reserved: ReadonlySet<string>): Promise<StructuredToolInterface[]> {
    return (await this.list(reserved)).flatMap((t) => (t.tool ? [t.tool] : []));
  }

  private async entry(name: string, file: string): Promise<CustomToolEntry> {
    const s = await lstat(file);
    const key = `${s.mtimeMs}:${s.size}`;
    const cached = this.cache.get(file);
    if (cached?.key === key) return cached.entry;
    let entry: CustomToolEntry;
    try {
      const described = (await this.call("describe", file, {}, {}, DESCRIBE_MS)) as Described;
      entry = { name, file, tool: this.tool(name, file, described) };
    } catch (err) {
      entry = { name, file, error: (err as Error).message };
      console.warn(`Skipping tool .osiris/${CUSTOM_TOOLS_DIR}/${name}: ${entry.error}`);
    }
    this.cache.set(file, { key, entry });
    return entry;
  }

  private tool(name: string, file: string, { description, input }: Described): StructuredToolInterface {
    return tool(
      async (args: unknown, config) => {
        const run = getRunContext(config);
        let fetches = 0;
        const onFetch = (req: SecretRequest) => {
          if (++fetches > MAX_FETCHES) throw new Error(`at most ${MAX_FETCHES} requests per call`);
          return fetchWithSecrets(this.vault, req, { userId: run.user_id, allowPrivate: this.options.allowPrivate, fetch: this.options.fetch, maxChars: MAX_FETCH_CHARS });
        };
        try {
          const value = String(await this.call("run", file, args ?? {}, { locale: run.locale ?? null, channel: run.channel }, this.options.runMs ?? RUN_MS, onFetch));
          return value.length > MAX_RESULT_CHARS ? `${value.slice(0, MAX_RESULT_CHARS)}\n… (zkráceno)` : value;
        } catch (err) {
          return `Nástroj ${name} selhal: ${(err as Error).message}`;
        }
      },
      { name, description, schema: input },
    ) as StructuredToolInterface;
  }

  /** One describe or run in a fresh sandboxed process. */
  private call(op: "describe" | "run", file: string, input: unknown, context: Record<string, unknown>, ms: number, onFetch?: (req: SecretRequest) => Promise<SecretResponse>): Promise<unknown> {
    const dir = this.dir;
    return new Promise((resolve, reject) => {
      const child = fork(RUNNER, [], {
        execArgv: ["--permission", `--allow-fs-read=${RUNNER}`, `--allow-fs-read=${dir}/`, "--max-old-space-size=128", "--no-warnings"],
        // No environment: no keys, no proxy settings, no NODE_OPTIONS of the runtime.
        env: {},
        cwd: dir,
        serialization: "advanced",
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      });
      let stderr = "";
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.kill("SIGKILL");
        fn();
      };
      const timer = setTimeout(() => finish(() => reject(new Error(`no answer within ${ms / 1000} s`))), ms);
      child.stderr!.on("data", (d: Buffer) => void (stderr = (stderr + d.toString()).slice(-2000)));
      child.on("message", (m: { type: string; id?: number; request?: SecretRequest; value?: unknown; error?: string }) => {
        if (m.type === "done") finish(() => (m.error === undefined ? resolve(m.value) : reject(new Error(m.error))));
        else if (m.type === "fetch" && m.id !== undefined && m.request) {
          const id = m.id;
          const answer = onFetch ? onFetch(m.request) : Promise.reject(new Error("ctx.fetch is only for calls"));
          answer.then(
            (response) => !settled && child.send({ type: "fetch-result", id, response }),
            (err: Error) => !settled && child.send({ type: "fetch-result", id, error: err.message }),
          );
        }
      });
      child.on("error", (err) => finish(() => reject(err)));
      child.on("exit", (code) => finish(() => reject(new Error(`the process ended (${code ?? "killed"})${stderr.trim() ? `: ${stderr.trim()}` : ""}`))));
      child.send({ type: "call", op, file, input, context });
    });
  }
}
