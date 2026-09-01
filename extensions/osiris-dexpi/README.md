# Osiris DEXPI

DEXPI / Proteus (XML P&ID) tooling for Osiris IDE.

## Features

- **P&ID preview** — a custom editor (`osiris-dexpi.preview`) that renders the
  plant model as an interactive SVG from the coordinates in the file. Click a
  symbol or an issue to jump to the corresponding line in the XML.
- **Structural validation** — `DEXPI: Validate Document` (and validate-on-save)
  populates the Problems panel with:
  | Code       | Meaning                                                  |
  | ---------- | -------------------------------------------------------- |
  | `DEXPI001` | PlantInformation missing OriginatingSystem/SchemaVersion |
  | `DEXPI002` | Duplicate `ID`                                           |
  | `DEXPI003` | Equipment missing a required attribute                   |
  | `DEXPI004` | Equipment has no drawable Position                       |
  | `DEXPI005` | Nozzle without an `ID`                                   |
  | `DEXPI006` | Segment with no `Connection`                             |
  | `DEXPI007` | Connection end (`FromID`/`ToID`) missing                 |
  | `DEXPI008` | Connection references an unknown element                 |
- **SVG export** — `DEXPI: Export P&ID as SVG`.
- Optional XSD validation when `osiris-dexpi.schemaPath` points at a Proteus schema.

## Architecture

| Module                               | Responsibility                     | vscode? |
| ------------------------------------ | ---------------------------------- | ------- |
| `src/parser/dexpiParser.ts`          | XML → normalized `DexpiModel`      | no      |
| `src/parser/schemaValidator.ts`      | `DexpiModel` → `ValidationIssue[]` | no      |
| `src/preview/renderSvg.ts`           | `DexpiModel` → SVG string          | no      |
| `src/preview/DexpiEditorProvider.ts` | custom editor + webview host       | yes     |
| `src/diagnostics.ts`                 | issues → `DiagnosticCollection`    | yes     |

The three `no` modules are covered by `vitest` against `test/fixtures/`.

## Development

```bash
pnpm --filter osiris-dexpi build     # esbuild → dist/extension.js + media/preview.js
pnpm --filter osiris-dexpi test
pnpm --filter osiris-dexpi package    # → osiris-dexpi.vsix
```

Press <kbd>F5</kbd> ("Run osiris-dexpi") and open
`test/fixtures/simple-valid.dexpi`, then _DEXPI: Open P&ID Preview_.
