# @osiris/desktop

The Osiris IDE desktop app. It **does not build VS Code from source** — it
downloads a pinned [VSCodium](https://github.com/VSCodium/vscodium) prebuilt and
rebrands it (product identity, icons, `codium` → `osiris`).

## Pipeline

```bash
pnpm --filter @osiris/desktop run prepare:shell   # fetch VSCodium prebuilt(s) + rebrand in place
pnpm --filter @osiris/desktop package             # repack → dist_electron/Osiris-<platform>-<release>.*
```

`prepare:shell` with no argument does this host's platform; CI passes an explicit
key (`node scripts/fetch-prebuilt.mjs darwin-arm64`).

`package` emits a portable archive per platform (`.tar.gz` on Linux, `.zip` on
Windows/macOS) and, for `linux-x64` only, an **AppImage** and a classic
confinement **snap** wrapping the same branded tree. The two extra Linux packages
are best-effort — `package.mjs` warns and skips them if `mksquashfs`
(`squashfs-tools`) is missing or `appimagetool` can't be fetched. Build one on
its own with `node scripts/pack-appimage.mjs` / `node scripts/pack-snap.mjs`.

| File / dir                   | Role                                                                |
| ---------------------------- | ------------------------------------------------------------------- |
| `config/upstream.json`       | pinned VSCodium repo + `release` tag + per-platform asset names     |
| `scripts/fetch-prebuilt.mjs` | download + `sha256`-verify + unpack into `.build/<platform>/`       |
| `scripts/rebrand.mjs`        | pure transforms (product.json curation, launcher patching) — tested |
| `scripts/apply-branding.mjs` | apply the rebrand to every staged platform                          |
| `scripts/package.mjs`        | repack the branded tree into `dist_electron/`                       |
| `scripts/pack-linux.mjs`     | pure text: `.desktop`, AppImage `AppRun`, snap `snap.yaml` — tested |
| `scripts/pack-tree.mjs`      | lay out the shared wrapper root (`usr/share/osiris/` + icon)        |
| `scripts/pack-appimage.mjs`  | wrap `linux-x64` → `.AppImage` (`appimagetool`, auto-downloaded)    |
| `scripts/pack-snap.mjs`      | wrap `linux-x64` → `.snap` (`mksquashfs`, classic confinement)      |
| `scripts/dev.mjs`            | launch this host's branded build straight from `.build/`            |
| `runtime/`                   | Electron main-process hook (not wired into the rebrand yet)         |

## Notes

- `.build/` and `dist_electron/` are git-ignored and disposable.
- The overlay in `@osiris/branding/product-overlay` is applied on top of the
  shipped `product.json`, **keeping** upstream's `builtInExtensions`, integrity
  `checksums`, `commit`/`version` and the working Open VSX gallery template.
- Archives are **portable and unsigned** — an alpha convenience, not installers.
  macOS users will need to clear the quarantine flag (`xattr -cr Osiris.app`).
- The `.tar.gz` ships Electron's `chrome-sandbox`; on a host with locked-down user
  namespaces it must be `sudo chown root:root chrome-sandbox && sudo chmod 4755
  chrome-sandbox`, or run with `--no-sandbox`. The **AppImage** does this check in
  `AppRun` and drops to `--no-sandbox` automatically (override with
  `OSIRIS_SANDBOX=1`). The **snap** is classic-confinement, so install it with
  `sudo snap install --dangerous --classic Osiris-linux-x64-<release>.snap`.
- Bumping `config/upstream.json` is a deliberate PR; the `release` value must be
  a real tag at github.com/VSCodium/vscodium/releases.
