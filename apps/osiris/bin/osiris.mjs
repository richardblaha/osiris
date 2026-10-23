#!/usr/bin/env node
// The `osiris` command: the agent over a project folder. Its sources are TypeScript, run through tsx.
import { register } from "tsx/esm/api";
register();
await import("../src/cli.ts");
