import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { initWorkspace } from '@osiris/dot-osiris';
import { WorkspaceServices } from './workspace.js';
import { runDoctor } from './doctor.js';

export interface CliIo {
  cwd: string;
  out: (text: string) => void;
  err: (text: string) => void;
  env?: NodeJS.ProcessEnv;
}

const USAGE = `osiris — multi-agent workspace CLI

Usage:
  osiris init [--force]                 scaffold .osiris/ from the system template
  osiris agent list                    list the crew defined in .osiris/agents/
  osiris crew run <task…> [--lead X] [--mcp]   run the crew on a task (--mcp: start MCP servers)
  osiris memory reindex                (re)index .osiris/memory/ into the vector store
  osiris memory watch                  reindex on every .osiris/memory/ change
  osiris memory search <query…> [-k N]  search the knowledge base
  osiris backlog list                  show the board (orphan branch osiris/backlog)
  osiris backlog new <title…> [--type T] [--state S] [--push]
  osiris backlog move <id> <state> [--push]   move a task (one commit on the orphan branch)
  osiris backlog push | pull           sync the orphan branch with its git remote
  osiris backlog lint                  static-check every task file
  osiris serve [--port N]              run osiris-server against this workspace
  osiris doctor                        health-check the workspace's Osiris setup
  osiris repl                          interactive REPL with crew/backlog/memory
`;

const MARK: Record<string, string> = { ok: '✓', warn: '⚠', fail: '✗' };

interface Flags {
  positionals: string[];
  values: Record<string, string | boolean>;
}

function parseFlags(args: string[]): Flags {
  const positionals: string[] = [];
  const values: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--force') values.force = true;
    else if (arg === '-k' || arg === '--limit') values.k = args[++i] ?? '';
    else if (arg === '--lead') values.lead = args[++i] ?? '';
    else if (arg === '--type') values.type = args[++i] ?? '';
    else if (arg === '--state') values.state = args[++i] ?? '';
    else if (arg === '--port') values.port = args[++i] ?? '';
    else if (arg.startsWith('--')) values[arg.slice(2)] = true;
    else positionals.push(arg);
  }
  return { positionals, values };
}

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const env = io.env ?? process.env;
  const group = argv[0];
  const flags = parseFlags(argv.slice(1));
  const sub = flags.positionals[0];
  flags.positionals = flags.positionals.slice(1);

  if (!group || group === 'help' || group === '--help' || group === '-h') {
    io.out(USAGE);
    return group ? 0 : 1;
  }

  const services = (): WorkspaceServices => new WorkspaceServices(io.cwd, env);

  try {
    switch (group) {
      case 'init': {
        const result = await initWorkspace(io.cwd, { force: flags.values.force === true });
        io.out(
          `init: ${result.written.length} written, ${result.skipped.length} kept${result.gitignoreChanged ? ', .gitignore updated' : ''}\n`,
        );
        return 0;
      }

      case 'agent': {
        if (sub !== 'list') return usageError(io);
        for (const a of await services().listAgents()) {
          io.out(
            `${a.name.padEnd(14)} ${a.role}${a.delegateTo.length ? `  → ${a.delegateTo.join(', ')}` : ''}\n`,
          );
        }
        return 0;
      }

      case 'crew': {
        if (sub !== 'run' || flags.positionals.length === 0) return usageError(io);
        const task = flags.positionals.join(' ');
        const crewEnv = flags.values.mcp ? { ...env, OSIRIS_MCP: '1' } : env;
        const result = await new WorkspaceServices(io.cwd, crewEnv).runCrew(
          task,
          flags.values.lead as string | undefined,
          (e) => {
            if (e.type === 'delegate') io.err(`  ${e.from} → ${e.to}: ${e.brief}\n`);
            if (e.type === 'agent.start') io.err(`▸ ${e.agent} (depth ${e.depth})\n`);
          },
        );
        io.out(`\n${result.text}\n`);
        io.err(`\n[${result.finishReason}, ${result.delegations.length} delegation(s)]\n`);
        return result.finishReason === 'error' ? 1 : 0;
      }

      case 'memory': {
        const svc = services();
        if (sub === 'reindex') {
          const r = await svc.reindexMemory();
          io.out(
            `reindex: ${r.filesIndexed} new/changed, ${r.filesUnchanged} unchanged, ${r.filesRemoved} removed, ${r.chunksUpserted} chunks, ${r.embeddingCalls} embed calls\n`,
          );
          return 0;
        }
        if (sub === 'watch') {
          const { watchMemory } = await import('./watch.js');
          io.out(`watching ${svc.paths.memory} — Ctrl+C to stop\n`);
          await watchMemory(svc, { onReindex: (s) => io.out(`  reindex: ${s}\n`) });
          return 0;
        }
        if (sub === 'search' && flags.positionals.length) {
          const hits = await svc.searchMemory(
            flags.positionals.join(' '),
            Number(flags.values.k ?? 6),
          );
          for (const h of hits) {
            io.out(
              `— ${h.metadata.source} (${h.score.toFixed(2)})\n${h.document.slice(0, 300)}\n\n`,
            );
          }
          if (hits.length === 0) io.out('no matches\n');
          return 0;
        }
        return usageError(io);
      }

      case 'backlog': {
        const backlogEnv = flags.values.push ? { ...env, OSIRIS_BACKLOG_AUTOPUSH: '1' } : env;
        const repo = await new WorkspaceServices(io.cwd, backlogEnv).openBacklog();
        if (sub === 'list') {
          const board = await repo.board();
          io.out(`branch: ${board.branch}\n`);
          for (const state of board.states) {
            const items = board.tasks.filter((t) => t.state === state);
            io.out(`\n${state} (${items.length})\n`);
            for (const t of items) io.out(`  [${t.type}] #${t.id} ${t.title}\n`);
          }
          return 0;
        }
        if (sub === 'new' && flags.positionals.length) {
          const task = await repo.create({
            type: (flags.values.type as string) || 'feat',
            title: flags.positionals.join(' '),
            state: flags.values.state as string | undefined,
          });
          io.out(`created #${task.id}: ${task.state}/${task.filename}\n`);
          return 0;
        }
        if (sub === 'move' && flags.positionals.length >= 2) {
          const moved = await repo.move(Number(flags.positionals[0]), flags.positionals[1]!);
          io.out(`#${moved.id} → ${moved.state}\n`);
          return 0;
        }
        if (sub === 'push' || sub === 'pull') {
          const result = sub === 'push' ? await repo.push() : await repo.pull();
          io.out(`${sub}: ${result.message}\n`);
          return result.ok ? 0 : 1;
        }
        if (sub === 'lint') {
          const issues = await repo.lint();
          for (const i of issues)
            io.out(`${i.severity === 'error' ? '✗' : '⚠'} ${i.where}: ${i.message}\n`);
          io.out(`${issues.length} issue(s)\n`);
          return issues.some((i) => i.severity === 'error') ? 1 : 0;
        }
        return usageError(io);
      }

      case 'serve': {
        const require = createRequire(import.meta.url);
        const bin = require.resolve('@osiris/server/dist/index.js');
        const child = spawn(process.execPath, [bin], {
          stdio: 'inherit',
          env: {
            ...env,
            OSIRIS_WORKSPACE_ROOT: io.cwd,
            PORT: (flags.values.port as string) ?? env.PORT ?? '8080',
          },
        });
        return new Promise<number>((resolve) => child.on('exit', (code) => resolve(code ?? 0)));
      }

      case 'doctor': {
        const checks = await runDoctor(io.cwd, env);
        for (const c of checks) io.out(`${MARK[c.level]} ${c.name.padEnd(18)} ${c.detail}\n`);
        const fails = checks.filter((c) => c.level === 'fail').length;
        io.out(`\n${checks.length} checks, ${fails} failing\n`);
        return fails ? 1 : 0;
      }

      case 'repl': {
        const { startRepl } = await import('./repl.js');
        await startRepl(services());
        return 0;
      }

      default:
        return usageError(io);
    }
  } catch (cause) {
    io.err(`error: ${(cause as Error).message}\n`);
    return 1;
  }
}

function usageError(io: CliIo): number {
  io.err(USAGE);
  return 1;
}
