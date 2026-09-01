# Desktop build resources

electron-builder reads packaging resources from this directory.

| Path                     | Purpose                             | Provided by                                               |
| ------------------------ | ----------------------------------- | --------------------------------------------------------- |
| `entitlements.mac.plist` | macOS hardened-runtime entitlements | committed                                                 |
| `icons/` (Linux)         | `512x512.png` etc.                  | generated from `@osiris/branding/assets/osiris.svg` in CI |
| `icon.ico` (Windows)     | app icon                            | generated in CI                                           |
| `icon.icns` (macOS)      | app icon                            | generated in CI                                           |

`.github/workflows/build-desktop.yml` runs the raster export (see
`packages/branding/assets/README.md`) into this folder before invoking
`pnpm --filter @osiris/desktop package`.
