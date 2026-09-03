import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import {
  FIRST_PARTY_EXTENSIONS,
  THEME_EXTENSION_DIR,
  buildThemeManifest,
} from '../scripts/bundle-extensions.mjs';

describe('bundle-extensions', () => {
  it('ships osiris-ai and osiris-workspace as first-party', () => {
    expect(FIRST_PARTY_EXTENSIONS).toEqual(['osiris-ai', 'osiris-workspace']);
  });

  it('buildThemeManifest carries the branding themes + editor defaults', async () => {
    const brandingPkg = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    );
    const manifest = buildThemeManifest(brandingPkg);

    expect(manifest.name).toBe(THEME_EXTENSION_DIR);
    expect(manifest.publisher).toBe('osiris-ide');
    expect(manifest.version).toBe(brandingPkg.version);
    expect(manifest.contributes.themes.map((t: { label: string }) => t.label)).toEqual([
      'Osiris Dark',
      'Osiris Light',
    ]);
    expect(manifest.contributes.configurationDefaults['workbench.colorTheme']).toBe('Osiris Dark');
    // no `main` — a pure theme extension
    expect(manifest.main).toBeUndefined();
  });
});
