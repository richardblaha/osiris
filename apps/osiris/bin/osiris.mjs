#!/usr/bin/env node
// The `osiris` command: the agent over a project folder. Its sources are TypeScript, run through tsx.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

// Older Node versions lack what Osiris uses (import.meta.dirname, process.loadEnvFile, …): say so plainly, also to the
// client that started the agent (it shows .osiris/private/agent-error).
if (Number(process.versions.node.split(".")[0]) < 24) {
  const message = `Osiris needs Node.js 24 or newer; this is ${process.version} (${process.execPath}).`;
  console.error(message);
  const folder = process.argv.slice(2).find((a) => !a.startsWith("-"));
  if (folder) {
    const dir = join(resolve(folder), ".osiris", "private");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "agent-error"), message);
  }
  process.exit(1);
}
const { register } = await import("tsx/esm/api");
register();
await import("../src/cli.ts");
