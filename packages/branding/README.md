# @osiris/branding

Everything that makes an Osiris build _look_ like Osiris:

- **Themes** — `Osiris Dark` / `Osiris Light` (also contributed as a VS Code theme
  extension so a plain Code - OSS build can load them).
- **`product.overlay.json`** — the subset of VSCodium's `product.json` that Osiris
  overrides (name, app ids, URL protocol, Open VSX gallery, telemetry off).
  `apps/*/scripts/apply-branding.mjs` deep-merges it into the cloned upstream.
- **`assets/`** — the master `osiris.svg` logo plus the raster-icon export recipe.
- **`src/metadata.ts`** — the single source of truth for product identity, colours
  and links, consumed by the apps and mirrored to `assets/metadata.json`.

```ts
import { metadata, loadProductOverlay, resolveIcon } from '@osiris/branding';

console.log(metadata.productNameLong); // "Osiris IDE"
const overlay = await loadProductOverlay(); // → merge into product.json
const icnsPath = resolveIcon('icns'); // → electron-builder mac icon
```
