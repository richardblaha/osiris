# @osiris/branding

Everything that makes an Osiris build _look_ like Osiris. This package **is** the
bundled theme extension (`contributes.themes` + `configurationDefaults`) and the
asset pipeline the two app builds pull from.

- **Themes** — `Osiris Dark` / `Osiris Light`, plus `configurationDefaults` that
  pin `workbench.colorTheme`, `editor.fontFamily` (Fira Code) and
  `editor.fontLigatures`. `product.overlay.json` also sets `initialColorTheme` so
  the very first window is dark before extensions activate.
- **`product.overlay.json`** — the subset of VSCodium's `product.json` that Osiris
  overrides (name, app ids, `.osiris*` data dirs, URL protocol, Open VSX gallery,
  telemetry off, initial theme). `apps/*/scripts/apply-branding.mjs` deep-merges it.
- **`assets/`** — master `osiris.svg`, the padded `osiris-icon.svg` every raster is
  derived from, the empty-editor watermarks, and the bundled Fira Code face.
- **`scripts/render-icons.mjs`** — rasterises the whole icon set from
  `osiris-icon.svg` (sharp / png-to-ico / @fiahfy/icns). `pnpm --filter
  @osiris/branding render:icons`.
- **`scripts/apply-to-checkout.mjs`** — `copyBrandingIntoCheckout(dir, { kind })`:
  copies icons + font into a cloned upstream tree, appends the Fira Code
  `@font-face`, and renames the workspace config folder `.vscode` → `.osiris`
  (`rewriteConfigFolder`, tolerant regex over a curated file list). Imported by
  both apps' `apply-branding.mjs`.
- **`scripts/bundle-extensions.mjs`** — `bundleBuiltinExtensions({ repoRoot,
  extensionsDir, build })`: unpacks the first-party `.vsix` set
  (`FIRST_PARTY_EXTENSIONS` = `osiris-ai`, `osiris-workspace`) into a
  distribution's `extensions/` dir and writes a generated `osiris-theme` built-in
  (`buildThemeManifest` + `themes/*.json`). Called by both apps' branding step.
- **`src/metadata.ts`** — the single source of truth for product identity, colours
  and links, consumed by the apps and mirrored to `assets/metadata.json`.

```ts
import { metadata, loadProductOverlay, resolveIcon } from '@osiris/branding';

console.log(metadata.productNameLong); // "Osiris IDE"
const overlay = await loadProductOverlay(); // → merge into product.json
const icnsPath = resolveIcon('icns'); // → electron-builder mac icon
```
