import { describe, expect, it } from 'vitest';
import { detectPreferredTheme } from '../src/detect.js';

function fakeWindow(query: string): Pick<Window, 'matchMedia'> {
  return {
    matchMedia: (q: string) =>
      ({ matches: q === query, media: q, onchange: null }) as unknown as MediaQueryList,
  };
}

describe('detectPreferredTheme', () => {
  it('prefers an explicit Electron nativeTheme', () => {
    expect(detectPreferredTheme({ nativeTheme: { shouldUseDarkColors: true } })).toBe(
      'osiris-dark',
    );
    expect(detectPreferredTheme({ nativeTheme: { shouldUseDarkColors: false } })).toBe(
      'osiris-light',
    );
  });

  it('honours the OSIRIS_THEME env var', () => {
    expect(detectPreferredTheme({ env: { OSIRIS_THEME: 'light' } })).toBe('osiris-light');
    expect(detectPreferredTheme({ env: { OSIRIS_THEME: 'osiris-dark' } })).toBe('osiris-dark');
  });

  it('reads the COLORFGBG terminal convention', () => {
    expect(detectPreferredTheme({ env: { COLORFGBG: '15;0' } })).toBe('osiris-dark');
    expect(detectPreferredTheme({ env: { COLORFGBG: '0;15' } })).toBe('osiris-light');
  });

  it('falls back to matchMedia in a browser/webview', () => {
    expect(detectPreferredTheme({ env: {}, win: fakeWindow('(prefers-color-scheme: dark)') })).toBe(
      'osiris-dark',
    );
    expect(
      detectPreferredTheme({ env: {}, win: fakeWindow('(prefers-color-scheme: light)') }),
    ).toBe('osiris-light');
  });

  it('uses the fallback when nothing is conclusive', () => {
    expect(detectPreferredTheme({ env: {}, win: undefined })).toBe('osiris-dark');
    expect(detectPreferredTheme({ env: {}, win: undefined, fallback: 'osiris-light' })).toBe(
      'osiris-light',
    );
  });
});
