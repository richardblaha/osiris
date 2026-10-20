import { spawn, spawnSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface BuildFile {
  path: string;
  data: Uint8Array;
}

export type BuildResult = { ok: true; files: BuildFile[] } | { ok: false; log: string };

export const LIMITS = { inputFiles: 2000, outputFiles: 5000, outputBytes: 200 * 1024 * 1024, timeoutMs: 120_000, logChars: 8000 };

/** The site's config and theme folder: `.vitepress` in VitePress, `_vitepress` in the tenant's files (no hidden names there). */
const CONFIG_DIR = "_vitepress";
const NODE_MODULES = join(import.meta.dirname, "../node_modules");
const VITEPRESS = join(NODE_MODULES, "vitepress/bin/vitepress.js");

/** Relative paths only: no absolute, `..`, empty or hidden segments, backslashes or control characters. */
export function safePath(path: string): string[] | null {
  const segs = path.split("/");
  const ok = segs.every((s) => s && s !== "." && s !== ".." && !s.startsWith(".") && s.length <= 255 && !/[\\\x00-\x1f\x7f]/.test(s));
  return ok && segs.length <= 32 ? segs : null;
}

/**
 * Builds a VitePress site from its source files in a fresh folder under /tmp, as a child process with nothing but
 * PATH in its environment, and returns the built files. The source runs code (the config, Vue in Markdown), so after
 * every build all processes it may have left behind are killed and the folder is removed; builds run one at a time.
 */
export async function build(files: BuildFile[]): Promise<BuildResult> {
  if (files.length > LIMITS.inputFiles) return { ok: false, log: `Příliš mnoho souborů (nejvýš ${LIMITS.inputFiles})` };
  const dir = await mkdtemp(join(tmpdir(), "vitepress-"));
  const src = join(dir, "src");
  const out = join(dir, "out");
  try {
    for (const f of files) {
      const segs = safePath(f.path);
      if (!segs) return { ok: false, log: `Neplatná cesta: ${f.path}` };
      if (segs[0] === CONFIG_DIR) segs[0] = ".vitepress";
      const abs = join(src, ...segs);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, f.data);
    }
    if (!files.some((f) => f.path === "index.md")) return { ok: false, log: "Chybí index.md" };
    // The config imports vitepress; ESM resolves it from the files' folders upwards.
    await symlink(NODE_MODULES, join(dir, "node_modules"), "dir");
    await writeFile(join(dir, "package.json"), JSON.stringify({ type: "module" }));

    const { code, log } = await run(dir, [VITEPRESS, "build", src, "--outDir", out]);
    if (code !== 0) return { ok: false, log };
    const built: BuildFile[] = [];
    let bytes = 0;
    for await (const path of walk(out, "")) {
      const data = await readFile(join(out, path));
      bytes += data.length;
      if (built.length >= LIMITS.outputFiles || bytes > LIMITS.outputBytes) return { ok: false, log: "Výsledný web je příliš velký" };
      built.push({ path, data });
    }
    return { ok: true, files: built };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function run(cwd: string, args: string[]): Promise<{ code: number | null; log: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: cwd, NODE_ENV: "production" },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let log = "";
    const keep = (chunk: Buffer) => {
      log = (log + chunk.toString("utf8")).slice(-LIMITS.logChars);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const timer = setTimeout(() => {
      keep(Buffer.from("\nSestavení trvalo příliš dlouho."));
      killAll(child.pid);
    }, LIMITS.timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      killAll(child.pid);
      resolve({ code, log: log.replace(/\x1b\[[0-9;]*m/g, "") });
    });
  });
}

/**
 * Kills whatever the build left running. In the container this server is PID 1, so a helper kills every other process
 * (kill -1 spares only PID 1 and the caller); elsewhere (development) only the build's process group.
 */
function killAll(pid: number | undefined) {
  if (process.pid === 1) spawnSync(process.execPath, ["-e", "process.kill(-1, 'SIGKILL')"]);
  else if (pid) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

async function* walk(root: string, rel: string): AsyncGenerator<string> {
  for (const e of await readdir(join(root, rel), { withFileTypes: true })) {
    const path = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) yield* walk(root, path);
    else if (e.isFile() && (await lstat(join(root, path))).isFile()) yield path;
  }
}
