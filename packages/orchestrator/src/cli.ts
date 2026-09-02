#!/usr/bin/env node
import { Orchestrator } from './runner.js';
import { ensureOllamaModel } from './ollama.js';
import { defaultStack, stackEmbedModel, stackModel, type DefaultStackOptions } from './stack.js';

const USAGE = `osiris-orchestrator — local dependency stack (Ollama, OTLP collector, dashboard, sync worker)

Usage:
  osiris-orchestrator up   [--dashboard aspire|jaeger] [--model <tag>] [--no-model]
                           [--embed-model <tag>] [--no-embed-model]
  osiris-orchestrator down
  osiris-orchestrator status

After "up", the chat + embedding models are pulled into Ollama if the local
library is missing them (once per install; cached in the osiris-ollama volume).
--no-model / --no-embed-model skip the respective pull.
`;

type Command = 'up' | 'down' | 'status';

interface ParsedArgs {
  command: Command;
  dashboard: NonNullable<DefaultStackOptions['dashboard']>;
  model?: string;
  embedModel?: string | null;
  pullModel: boolean;
}

function parse(argv: readonly string[]): ParsedArgs {
  const command = argv[0];
  let dashboard: ParsedArgs['dashboard'] = 'aspire';
  let model: string | undefined;
  let embedModel: string | null | undefined;
  let pullModel = true;

  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--dashboard') {
      const value = argv[i + 1];
      if (value === 'aspire' || value === 'jaeger') dashboard = value;
      i++;
    } else if (argv[i] === '--model') {
      model = argv[i + 1];
      i++;
    } else if (argv[i] === '--embed-model') {
      embedModel = argv[i + 1];
      i++;
    } else if (argv[i] === '--no-embed-model') {
      embedModel = null;
    } else if (argv[i] === '--no-model') {
      pullModel = false;
    }
  }

  if (command === 'up' || command === 'down' || command === 'status') {
    return { command, dashboard, model, embedModel, pullModel };
  }
  process.stdout.write(USAGE);
  process.exit(command === undefined ? 0 : 1);
}

async function main(): Promise<void> {
  const { command, dashboard, model, embedModel, pullModel } = parse(process.argv.slice(2));
  const spec = defaultStack({ dashboard, model, embedModel });
  const orchestrator = new Orchestrator();

  if (command === 'up') {
    await orchestrator.up(spec);
    process.stdout.write(`stack "${spec.project}" is up\n`);
    if (pullModel) {
      for (const tag of [stackModel(spec), stackEmbedModel(spec)]) {
        if (!tag) continue;
        const { pulled } = await ensureOllamaModel(tag, {
          onProgress: ({ status, fraction }) => {
            const pct = fraction !== undefined ? ` ${Math.round(fraction * 100)}%` : '';
            process.stdout.write(`  ${status}${pct}\n`);
          },
        });
        process.stdout.write(`model ${tag} ${pulled ? 'pulled' : 'already present'}\n`);
      }
    }
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
