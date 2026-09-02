#!/usr/bin/env node
import { Orchestrator } from './runner.js';
import { defaultStack, type DefaultStackOptions } from './stack.js';

const USAGE = `osiris-orchestrator — local dependency stack (Ollama, OTLP collector, dashboard, sync worker)

Usage:
  osiris-orchestrator up      [--dashboard aspire|jaeger]
  osiris-orchestrator down
  osiris-orchestrator status
`;

type Command = 'up' | 'down' | 'status';

interface ParsedArgs {
  command: Command;
  dashboard: NonNullable<DefaultStackOptions['dashboard']>;
}

function parse(argv: readonly string[]): ParsedArgs {
  const command = argv[0];
  let dashboard: ParsedArgs['dashboard'] = 'aspire';

  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--dashboard') {
      const value = argv[i + 1];
      if (value === 'aspire' || value === 'jaeger') dashboard = value;
      i++;
    }
  }

  if (command === 'up' || command === 'down' || command === 'status') {
    return { command, dashboard };
  }
  process.stdout.write(USAGE);
  process.exit(command === undefined ? 0 : 1);
}

async function main(): Promise<void> {
  const { command, dashboard } = parse(process.argv.slice(2));
  const spec = defaultStack({ dashboard });
  const orchestrator = new Orchestrator();

  if (command === 'up') {
    await orchestrator.up(spec);
    process.stdout.write(`stack "${spec.project}" is up\n`);
    return;
  }
  if (command === 'down') {
    await orchestrator.down(spec);
    process.stdout.write(`stack "${spec.project}" is down\n`);
    return;
  }

  const rows = await orchestrator.status(spec);
  if (rows.length === 0) {
    process.stdout.write('no containers for project "osiris"\n');
    return;
  }
  for (const row of rows) {
    process.stdout.write(`${row.service.padEnd(16)} ${row.state.padEnd(10)} ${row.status}\n`);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
