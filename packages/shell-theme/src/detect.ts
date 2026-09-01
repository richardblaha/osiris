/** Colour-scheme detection that works in Electron/Node and in a browser/webview. */

export type OsirisTheme = 'osiris-dark' | 'osiris-light';

export interface DetectOptions {
  /** Injected for testing; defaults to the ambient `globalThis`. */
  win?: Pick<Window, 'matchMedia'> | undefined;
  /** Injected for testing; defaults to `process.env` when available. */
  env?: Record<string, string | undefined> | undefined;
  /** Electron `nativeTheme`-like object, when the caller has one. */
  nativeTheme?: { shouldUseDarkColors: boolean } | undefined;
  /** Fallback when nothing else is conclusive. */
  fallback?: OsirisTheme;
}

const ENV_KEYS = ['OSIRIS_THEME', 'COLORFGBG'];

function fromEnv(env: Record<string, string | undefined>): OsirisTheme | undefined {
  const explicit = (env.OSIRIS_THEME ?? '').toLowerCase();
  if (explicit === 'dark' || explicit === 'osiris-dark') {
    return 'osiris-dark';
  }
  if (explicit === 'light' || explicit === 'osiris-light') {
    return 'osiris-light';
  }
  // `COLORFGBG` (rxvt/iTerm convention): "fg;bg" — bg 0..6 or 8 means dark.
  const colorFgBg = env.COLORFGBG;
  if (colorFgBg) {
    const parts = colorFgBg.split(';');
    const bg = Number(parts[parts.length - 1]);
    if (!Number.isNaN(bg)) {
      return bg <= 6 || bg === 8 ? 'osiris-dark' : 'osiris-light';
    }
  }
  return undefined;
}

/** Best-effort detection of the user's preferred Osiris theme. */
export function detectPreferredTheme(options: DetectOptions = {}): OsirisTheme {
  const fallback = options.fallback ?? 'osiris-dark';

  if (options.nativeTheme) {
    return options.nativeTheme.shouldUseDarkColors ? 'osiris-dark' : 'osiris-light';
  }

  const env =
    options.env ??
    (typeof process !== 'undefined' ? (process.env as Record<string, string | undefined>) : {});
  const fromEnvResult = fromEnv(env);
  if (fromEnvResult) {
    return fromEnvResult;
  }

  const win =
    options.win ??
    (typeof globalThis !== 'undefined' ? (globalThis as unknown as Window) : undefined);
  if (win && typeof win.matchMedia === 'function') {
    if (win.matchMedia('(prefers-color-scheme: dark)').matches) {
      return 'osiris-dark';
    }
    if (win.matchMedia('(prefers-color-scheme: light)').matches) {
      return 'osiris-light';
    }
  }

  return fallback;
}

/** The env keys `detectPreferredTheme` inspects, for documentation/tests. */
export const INSPECTED_ENV_KEYS = ENV_KEYS;
