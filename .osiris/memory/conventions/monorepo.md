# Monorepo conventions

- pnpm workspaces + Turborepo. Node 22, pnpm 9 (corepack). MIT.
- Every package: ESM, `tsc` emit to `dist/`, `composite` project refs, add to
  root `tsconfig.json` `references`, `vitest run` for tests.
- Pure logic is unit-tested. Docker / ChromaDB-server / real-git edges sit
  behind an interface with an in-memory (or file-backed) fake, exercised by one
  integration test.
- No secret is ever persisted; API keys come from `context.secrets` / env at
  call time.
- Verify with `pnpm build && pnpm lint && pnpm typecheck && pnpm test`.
- The upstream VS Code source is never vendored; the desktop/web builds clone a
  pinned tag and apply overlays + patches.
