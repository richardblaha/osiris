import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { metadata } from '../src/metadata.js';
import { loadProductOverlay, productOverlayPath, themePaths } from '../src/index.js';

describe('branding metadata', () => {
  it('exposes the Osiris accent colours', () => {
    expect(metadata.colors.accent).toBe('#00FFFF');
    expect(metadata.colors.accentAlt).toBe('#FF00FF');
  });

  it('product overlay parses and drops the $comment key', async () => {
    const overlay = await loadProductOverlay();
    expect(overlay.$comment).toBeUndefined();
    expect(overlay.nameLong).toBe('Osiris IDE');
    expect(overlay.applicationName).toBe(metadata.applicationName);
    expect(overlay.enableTelemetry).toBe(false);
  });

  it('overlay disables the Microsoft gallery in favour of Open VSX', async () => {
    const raw = await readFile(productOverlayPath, 'utf8');
    expect(raw).toContain('open-vsx.org');
    expect(raw).not.toContain('marketplace.visualstudio.com');
  });

  it('assets/metadata.json mirrors src/metadata.ts', async () => {
    const mirror = JSON.parse(
      await readFile(new URL('../assets/metadata.json', import.meta.url), 'utf8'),
    );
    delete mirror.$comment;
    expect(mirror).toEqual(JSON.parse(JSON.stringify(metadata)));
  });

  it('theme files are valid JSON with matching names', async () => {
    const dark = JSON.parse(await readFile(themePaths.dark, 'utf8'));
    const light = JSON.parse(await readFile(themePaths.light, 'utf8'));
    expect(dark.name).toBe('Osiris Dark');
    expect(light.name).toBe('Osiris Light');
    expect(dark.type).toBe('dark');
    expect(light.type).toBe('light');
  });
});
