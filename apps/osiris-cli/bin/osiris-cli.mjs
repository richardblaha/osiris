#!/usr/bin/env node
// The `osiris-cli` command: Osiris in the terminal. Its sources are TypeScript (React for the terminal), run through tsx
// with this package's tsconfig (JSX), wherever it's started from.
import { fileURLToPath } from "node:url";
import { register } from "tsx/esm/api";
register({ tsconfig: fileURLToPath(new URL("../tsconfig.json", import.meta.url)) });
await import("../src/main.tsx");
