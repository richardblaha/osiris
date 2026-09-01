# Osiris STEP

ISO 10303-21 (STEP Part 21, `.step` / `.stp` / `.p21`) tooling for Osiris IDE.

## Features

- **3D preview** — a read-only custom editor (`osiris-step.preview`) that renders
  a wireframe + point cloud with three.js, orbit controls and fit-to-view.
- **`STEP: Show File Header`** — the parsed `FILE_DESCRIPTION` / `FILE_NAME` /
  `FILE_SCHEMA` as JSON.
- **`STEP: Entity Statistics`** — entity count, distinct types and the most
  common entity types.

## Parser

| Module                              | Responsibility                                                               | vscode? |
| ----------------------------------- | ---------------------------------------------------------------------------- | ------- |
| `src/parser/tokenizer.ts`           | Part 21 lexer (refs, reals, strings, enums, comments)                        | no      |
| `src/parser/stepParser.ts`          | envelope + `HEADER` + `DATA` → `StepModel` (forward refs, complex instances) | no      |
| `src/geometry/extract.ts`           | `StepModel` → wireframe `StepGeometry`                                       | no      |
| `src/stats.ts`                      | entity-type aggregation                                                      | no      |
| `src/preview/StepEditorProvider.ts` | custom editor + three.js webview host                                        | yes     |

### Scope

The geometry extractor reads `CARTESIAN_POINT` coordinates and connects them
along `POLYLINE`, `B_SPLINE_CURVE*` control polygons, `POLY_LOOP` rings and
`EDGE_CURVE` endpoints. **It does not tessellate NURBS or B-rep surfaces** — the
preview is a recognizable wireframe, not an analysis mesh. Files with more than
`osiris-step.maxPreviewEntities` entities are parsed but not drawn.

## Development

```bash
pnpm --filter osiris-step build      # esbuild bundles three.js into media/preview.js
pnpm --filter osiris-step test
pnpm --filter osiris-step package
```

Press <kbd>F5</kbd> ("Run osiris-step"), open
`test/fixtures/cube-wireframe.step`, then _STEP: Open 3D Preview_.
