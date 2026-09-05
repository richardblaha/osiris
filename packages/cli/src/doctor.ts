import { stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { osirisPaths, resolveOsirisFile, listOsirisDir } from '@richardblaha/dot-osiris';
import { loadAgentRegistry, loadCrewConfig, parseModelSpec } from '@osiris/crew';
import { parseMcpConfig } from '@richardblaha/mcp';
import { parseMemoryConfig } from '@osiris/memory';
import { BacklogRepo } from '@osiris/backlog';

const exec = promisify(execFile);

export type CheckLevel = 'ok' | 'warn' | 'fail';

export interface Check {
  level: CheckLevel;
  name: string;
  detail: string;
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** A read-only health check of a workspace's Osiris setup. */
export async function runDoctor(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Check[]> {
  const checks: Check[] = [];
  const paths = osirisPaths(root);
  const add = (level: CheckLevel, name: string, detail: string): void => {
    checks.push({ level, name, detail });
  };

  // --- git repository ---------------------------------------------------
  try {
    const { stdout } = await exec('git', ['rev-parse', '--show-toplevel'], { cwd: root });
    add('ok', 'git repository', stdout.trim());
  } catch {
    add('fail', 'git repository', 'not a git repo — run `git init` (the backlog needs one)');
  }

  // --- .osiris/ --------------------------------------------------------
  add(
    (await isDir(paths.dir)) ? 'ok' : 'warn',
    '.osiris/ folder',
    (await isDir(paths.dir))
      ? paths.dir
      : 'missing — the bundled system template is used as a fallback (run `osiris init`)',
  );

  // --- agents --------------------------------------------------------
  try {
    const files = await listOsirisDir(paths, 'agents', {
      recursive: true,
      filter: (r) => r.endsWith('.md') && r !== 'README.md',
    });
    const registry = await loadAgentRegistry(paths);
    const loaded = registry.list().length;
    add(
      loaded === files.length ? 'ok' : 'warn',
      'crew agents',
      `${loaded}/${files.length} parsed: ${registry
        .list()
        .map((a) => a.name)
        .join(', ')}`,
    );
  } catch (cause) {
    add('fail', 'crew agents', (cause as Error).message);
  }

  // --- crew.json ----------------------------------------------------
  try {
    const config = await loadCrewConfig(paths, env);
    const providers = new Set(
      [config.defaultModel, ...Object.values(config.taskModels ?? {})].map(
        (s) => parseModelSpec(String(s)).provider,
      ),
    );
    const missing = [...providers].filter((p) => p && !(p in config.providers) && p !== 'echo');
    add(
      missing.length ? 'warn' : 'ok',
      'crew.json',
      `lead=${config.lead}, providers=[${Object.keys(config.providers).join(', ')}]` +
        (missing.length ? `; models reference undeclared provider(s): ${missing.join(', ')}` : ''),
    );
  } catch (cause) {
    add('fail', 'crew.json', (cause as Error).message);
  }

  // --- memory / ChromaDB ------------------------------------------
  const mem = parseMemoryConfig((await resolveOsirisFile(paths, 'memory.json'))?.content, env);
  const chromaUrl = env.OSIRIS_CHROMA_URL ?? mem.chroma.url;
  if (chromaUrl && /^https?:\/\//.test(chromaUrl)) {
    try {
      const base = new URL(chromaUrl);
      const res = await fetch(`${base.origin}/api/v2/heartbeat`).catch(() =>
        fetch(`${base.origin}/api/v1/heartbeat`),
      );
      add(res.ok ? 'ok' : 'warn', 'ChromaDB', `${chromaUrl} → HTTP ${res.status}`);
    } catch (cause) {
      add(
        'warn',
        'ChromaDB',
        `${chromaUrl} unreachable (${(cause as Error).message}) — a local store is used`,
      );
    }
  } else {
    add(
      'ok',
      'memory store',
      `local (${mem.embedding.provider} embedding) — set OSIRIS_CHROMA_URL for ChromaDB`,
    );
  }

  // --- MCP servers -------------------------------------------------
  const specs = parseMcpConfig((await resolveOsirisFile(paths, 'mcp.json'))?.content, {
    workspaceFolder: root,
    env,
  });
  const enabled = specs.filter((s) => s.enabled);
  add(
    'ok',
    'MCP servers',
    specs.length === 0
      ? 'none configured'
      : `${enabled.length}/${specs.length} enabled: ${specs.map((s) => `${s.id}${s.enabled ? '' : ' (off)'}`).join(', ')}`,
  );

  // --- backlog ----------------------------------------------------
  try {
    const repo = await BacklogRepo.open({ repoRoot: root });
    const issues = await repo.lint();
    const errs = issues.filter((i) => i.severity === 'error');
    const tasks = await repo.list();
    add(
      errs.length ? 'fail' : issues.length ? 'warn' : 'ok',
      'backlog',
      `branch ${repo.branch}, ${tasks.length} task(s)` +
        (issues.length
          ? `; ${errs.length} error(s), ${issues.length - errs.length} warning(s)`
          : ''),
    );
    for (const issue of issues.slice(0, 5)) {
      add(issue.severity === 'error' ? 'fail' : 'warn', `  backlog: ${issue.where}`, issue.message);
    }
  } catch (cause) {
    add('warn', 'backlog', `not initialised yet (${(cause as Error).message})`);
  }

  return checks;
}
