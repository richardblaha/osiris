# No .NET anywhere

The Osiris platform has **no .NET** in build or runtime. The former .NET Aspire
AppHost was replaced by three TypeScript pieces: `@osiris/orchestrator` (a
dockerode runner over a declarative `StackSpec`), `@richardblaha/osiris-telemetry`
(`@opentelemetry/sdk-node` → OTLP/HTTP) and a container dashboard run _as a
container_, not built.

Everything is ESM TypeScript, built with `tsc` to `dist/`, on pnpm workspaces +
Turborepo.
