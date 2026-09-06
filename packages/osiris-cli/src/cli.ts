#!/usr/bin/env node
import { runCli } from './run.js';

runCli(process.argv.slice(2), {
  cwd: process.cwd(),
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
})
  .then((code) => process.exit(code))
  .catch((cause: unknown) => {
    process.stderr.write(`fatal: ${cause instanceof Error ? cause.stack : String(cause)}\n`);
    process.exit(1);
  });
