#!/usr/bin/env node
// The `osiris-cli` command: Osiris in the terminal. Its sources are TypeScript (React for the terminal), run through tsx
// with this package's tsconfig (JSX), wherever it's started from.
import { fileURLToPath } from "node:url";

if (Number(process.versions.node.split(".")[0]) < 24) {
  console.error(`osiris-cli needs Node.js 24 or newer; this is ${process.version} (${process.execPath}).`);
  process.exit(1);
}
const { register } = await import("tsx/esm/api");
register({ tsconfig: fileURLToPath(new URL("../tsconfig.json", import.meta.url)) });
await import("../src/main.tsx");
