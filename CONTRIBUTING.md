# Contributing to Osiris IDE

Thanks for your interest in improving Osiris. This document covers governance,
the development workflow, and the conventions the project enforces in CI.

## Governance

Osiris is maintained under a lightweight **maintainer + reviewers** model:

- **Maintainers** own the roadmap, cut releases, and have merge rights on every path.
- **Area reviewers** own a subdirectory (`extensions/osiris-step`, `apps/osiris-web`, …)
  listed in [`CODEOWNERS`](.github/CODEOWNERS) and must approve changes there.
- Decisions are made by lazy consensus on issues and PRs. Anything contentious is
  escalated to a maintainer, whose decision is final for that change.

New contributors are added as area reviewers after a few substantive merged PRs.

## Ground rules

- Be respectful — the [Code of Conduct](CODE_OF_CONDUCT.md) applies everywhere.
- One logical change per PR. Keep diffs reviewable.
- Every code change ships with tests and updated docs.
- Do not add Microsoft trademarked assets or copy upstream VS Code source into the repo.

## Development setup

```bash
corepack enable          # provides pnpm 9
nvm use                  # Node 22 (from .nvmrc)
pnpm install
pnpm build && pnpm test  # sanity check
```

### Where things live

| You want to…                                | Work in                |
| ------------------------------------------- | ---------------------- |
| Change shared types / telemetry / events    | `packages/shared-core` |
| Change product name, icons, theme defaults  | `packages/branding`    |
| Change theme detection / provider logic     | `packages/shell-theme` |
| Change an in-box extension                  | `extensions/osiris-*`  |
| Change desktop packaging / branding overlay | `apps/osiris-desktop`  |
| Change the web runtime                      | `apps/osiris-web`      |
| Change lint / tsconfig rules for everyone   | `toolchain/*`          |

### Per-workspace scripts

Every workspace exposes the same script names so Turborepo can fan out:

```bash
pnpm --filter <name> build      # compile / bundle
pnpm --filter <name> test       # vitest
pnpm --filter <name> lint
pnpm --filter <name> typecheck
pnpm --filter osiris-<ext> package   # build a .vsix (extensions only)
```

`<name>` is the `name` field in that workspace's `package.json`
(`@osiris/shared-core`, `osiris-dexpi`, `@osiris/desktop`, …).

## Branch & PR flow

1. Fork (external) or branch (maintainers): `git switch -c feat/step-brep-loops`.
2. Make the change; run `pnpm lint && pnpm typecheck && pnpm test` locally.
3. Commit with **Conventional Commits** and a **DCO sign-off**:
   ```
   git commit -s -m "feat(osiris-step): parse ADVANCED_FACE poly loops"
   ```
   `-s` adds `Signed-off-by:` — required. We do not require a CLA; the DCO
   (https://developercertificate.org/) is enough.
4. Open a PR against `main`. Fill in the PR template. Link the issue it closes.
5. CI must be green and the relevant `CODEOWNERS` must approve.
6. Maintainers squash-merge; the squash subject must itself be a valid
   Conventional Commit (it becomes the changelog entry).

### Conventional Commit scopes

`shared-core`, `branding`, `shell-theme`, `osiris-ai`, `osiris-dexpi`,
`osiris-step`, `desktop`, `web`, `toolchain`, `ci`, `repo`.

Types: `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `build`, `ci`, `chore`.
A `!` after the scope or a `BREAKING CHANGE:` footer marks a breaking change.

## Releases

Releases are tag-driven. A maintainer:

1. Bumps versions and updates the top-level `CHANGELOG.md` and the
   `extensions/*/CHANGELOG.md` files.
2. Tags `vX.Y.Z` (or `vX.Y.Z-alpha.N` for a pre-release) and pushes.
3. `release.yml` packs the extensions and calls the reusable `build-desktop.yml`
   and `build-web.yml` workflows, then creates a **draft** GitHub Release with
   every `.vsix`, the desktop installers and the web server bundle attached.
   A tag containing a hyphen is marked as a pre-release.
4. A maintainer reviews the draft and publishes it.

## Reporting bugs / requesting features

Use the [issue templates](.github/ISSUE_TEMPLATE/). Security issues go through
[SECURITY.md](SECURITY.md), **not** public issues.
