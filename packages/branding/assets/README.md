# Osiris branding assets

| File | Purpose | Source |
| --- | --- | --- |
| `osiris.svg` | Master logo — 3D cyan/magenta pyramid. **Canonical.** | hand-authored |
| `osiris-icon.svg` | Padded app-icon variant (pyramid on the `#121212` rounded ground). Source for every raster target. | hand-authored |
| `letterpress-{dark,light,hc}.svg` | Single-tone empty-editor watermark, one per workbench theme kind. | hand-authored |
| `fonts/FiraCode-VF.woff2` | Bundled editor font (variable, weights 300–700) so a fresh install needs no system font. | tonsky/FiraCode, OFL-1.1 |
| `fonts/OFL.txt` | SIL Open Font License for the above. Shipped into the checkout as `ThirdPartyNotices-FiraCode.txt`. | — |
| `metadata.json` | _(generated)_ mirror of `src/metadata.ts` for non-TS consumers. | build step |
| `generated/` | _(git-ignored)_ the full rasterised icon set. | `scripts/render-icons.mjs` |

## Rasterising the icon set

`osiris-icon.svg` is the single source of truth. `scripts/render-icons.mjs`
(sharp + png-to-ico + @fiahfy/icns — no system tooling) produces everything under
`assets/generated/`:

```bash
pnpm --filter @osiris/branding render:icons
```

| Output | Target |
| --- | --- |
| `png/icon-{16..1024}.png` | generic ladder, PWA manifest, docs |
| `linux/code.png` | `resources/linux/code.png` in the checkout |
| `darwin/code.icns` | `resources/darwin/code.icns` |
| `win32/code.ico`, `code_{70x70,150x150}.png` | `resources/win32/*` |
| `server/favicon.ico`, `code-{192,512}.png` | `resources/server/*` (both distributions) |
| `electron/icon.{ico,icns}`, `electron/icons/*.png` | `apps/osiris-desktop/build/*` for electron-builder |

`apps/*/scripts/apply-branding.mjs` call `render-icons` automatically (via
`@osiris/branding/apply-to-checkout`) when `generated/` is absent, then copy each
file to its upstream path and append the Fira Code `@font-face` to the workbench
stylesheet. CI (`build-desktop`, `build-web`) runs `render:icons` explicitly
before `prepare:shell`.
