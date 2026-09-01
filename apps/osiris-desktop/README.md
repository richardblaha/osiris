# @osiris/desktop

Electron desktop packaging for Osiris IDE. This app **does not vendor VS Code** —
it clones a pinned VSCodium tag at build time and applies Osiris branding + patches.

## Pipeline

```bash
pnpm --filter @osiris/desktop run prepare:shell   # 1. clone VSCodium @ config/upstream.json
                                                  #    2. merge product.json overlay + copy assets
                                                  #    3. git apply patches/*.patch
pnpm --filter @osiris/desktop build               # drive the upstream build (long, toolchain-heavy)
pnpm --filter @osiris/desktop package             # electron-builder → dist_electron/
```

| File / dir                   | Role                                                                        |
| ---------------------------- | --------------------------------------------------------------------------- |
| `config/upstream.json`       | pinned VSCodium repo + tag                                                  |
| `scripts/clone-upstream.mjs` | idempotent shallow clone into `.build/vscodium`                             |
| `scripts/apply-branding.mjs` | product.json deep-merge, asset copy, `git apply` patches                    |
| `scripts/lib.mjs`            | `mergeDeep`, overlay loader (tested via `node --test`)                      |
| `patches/*.patch`            | tracked downstream changes; non-applying patches are skipped with a warning |
| `electron-builder.yml`       | Linux (AppImage/deb/rpm), macOS (dmg/zip), Windows (nsis)                   |
| `build/`                     | entitlements + icons (icons generated in CI)                                |

## Notes

- `.build/` is git-ignored and disposable — re-run `prepare:shell` any time.
- The heavy upstream build is validated in CI (`build-desktop.yml`) across
  ubuntu/macos/windows, not by local unit tests.
- Bumping `config/upstream.json` is a deliberate PR; re-roll any `patches/*` that
  stop applying against the new tag.
- Telemetry is forced off via the branding overlay (`enableTelemetry: false`).
