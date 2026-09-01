#!/usr/bin/env node
/**
 * Thin Osiris wrapper around the built OpenVSCode Server.
 *
 * Responsibilities:
 *   - parse a small, stable CLI (`--port`, `--host`, `--token`, `--help`);
 *   - set Osiris environment (data dir, telemetry off, product name);
 *   - print an Osiris banner + a `/healthz`-style readiness line;
 *   - exec the upstream server entrypoint, forwarding remaining args.
 *
 * With no built checkout present it still runs `--help` and prints the banner so
 * `node server/index.mjs --help` works in CI smoke tests.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readUpstreamConfig, findServerEntrypoint } from '../scripts/lib.mjs';

const appRoot = fileURLToPath(new URL('../', import.meta.url));

export function parseArgs(argv) {
  const opts = { port: 3000, host: '0.0.0.0', token: undefined, help: false, rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--port') opts.port = Number(argv[++i]);
    else if (arg?.startsWith('--port=')) opts.port = Number(arg.slice(7));
    else if (arg === '--host') opts.host = argv[++i];
    else if (arg?.startsWith('--host=')) opts.host = arg.slice(7);
    else if (arg === '--token') opts.token = argv[++i];
    else if (arg?.startsWith('--token=')) opts.token = arg.slice(8);
    else opts.rest.push(arg);
  }
  return opts;
}

const BANNER = String.raw`
   ____       _      _
  / __ \___  (_)____(_)____
 / / / / __ \/ / ___/ / ___/   Osiris IDE — web runtime
/ /_/ / /_/ / / /  / (__  )    telemetry: off
\____/\____/_/_/  /_/____/
`;

function help() {
  process.stdout.write(BANNER);
  process.stdout.write(`
Usage: osiris-web [options] [-- <upstream server args>]

  --port <n>       port to listen on (default 3000)
  --host <addr>    address to bind (default 0.0.0.0)
  --token <str>    connection token (default: none; upstream may generate one)
  -h, --help       show this help

Prepare + build the runtime first:
  pnpm --filter @osiris/web run prepare:shell
  pnpm --filter @osiris/web build
`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    help();
    return;
  }

  process.stdout.write(BANNER);

  const env = {
    ...process.env,
    OSIRIS_TELEMETRY: 'off',
    VSCODE_SERVER_DATA_DIR:
      process.env.VSCODE_SERVER_DATA_DIR ?? path.join(appRoot, '.osiris-server'),
    OSIRIS_PRODUCT_NAME: 'Osiris IDE',
  };

  const { checkoutDir } = await readUpstreamConfig();
  const entrypoint = existsSync(checkoutDir) ? findServerEntrypoint(checkoutDir) : undefined;

  if (!entrypoint) {
    console.error(
      '[osiris-web] no built server found. Run `pnpm --filter @osiris/web run prepare:shell && pnpm --filter @osiris/web build` first.',
    );
    process.exitCode = 1;
    return;
  }

  const args = [
    '--host',
    opts.host,
    '--port',
    String(opts.port),
    ...(opts.token ? ['--connection-token', opts.token] : ['--without-connection-token']),
    ...opts.rest,
  ];

  console.error(`[osiris-web] starting ${path.basename(entrypoint)} on ${opts.host}:${opts.port}`);
  const runner = entrypoint.endsWith('.js')
    ? spawn(process.execPath, [entrypoint, ...args], { stdio: 'inherit', env })
    : spawn(entrypoint, args, { stdio: 'inherit', env });

  runner.on('exit', (code) => process.exit(code ?? 0));
  const stop = () => runner.kill('SIGTERM');
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
