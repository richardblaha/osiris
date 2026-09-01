# @osiris/shell-theme

Runtime helpers for choosing and tracking the active Osiris colour theme, shared
by `apps/osiris-desktop` and `apps/osiris-web`.

- **`detectPreferredTheme(opts)`** — resolves `osiris-dark` / `osiris-light` from,
  in priority order: an Electron `nativeTheme`, `OSIRIS_THEME` / `COLORFGBG` env
  vars, a browser `matchMedia('(prefers-color-scheme: …)')`, then a fallback.
- **`ThemeProvider`** — holds the current theme, emits `onDidChange`, supports
  `toggle()`, and persists the user's choice through any `StorageAdapter`
  (`localStorage`, VS Code `Memento`, a file, …). `workbenchColorTheme` maps to
  the label contributed by `@osiris/branding` (`"Osiris Dark"` / `"Osiris Light"`).

```ts
import { ThemeProvider } from '@osiris/shell-theme';

const themes = new ThemeProvider({ storage: window.localStorage });
await themes.hydrate();
themes.onDidChange((t) => (document.documentElement.dataset.theme = t));
```
