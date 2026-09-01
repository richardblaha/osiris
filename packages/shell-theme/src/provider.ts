import { metadata } from '@osiris/branding';
import { detectPreferredTheme, type DetectOptions, type OsirisTheme } from './detect.js';

export interface StorageAdapter {
  get(key: string): string | null | Promise<string | null>;
  set(key: string, value: string): void | Promise<void>;
}

export interface ThemeProviderOptions {
  storage?: StorageAdapter;
  detect?: DetectOptions;
  /** Explicit initial theme; skips detection. */
  initial?: OsirisTheme;
}

export type ThemeListener = (theme: OsirisTheme) => void;

const STORAGE_KEY = 'osiris.shell-theme';

const LABELS: Record<OsirisTheme, string> = {
  'osiris-dark': 'Osiris Dark',
  'osiris-light': 'Osiris Light',
};

/**
 * Tracks the active Osiris theme, notifies listeners on change, and (optionally)
 * persists the user's choice through a host-supplied storage adapter.
 */
export class ThemeProvider {
  private current: OsirisTheme;
  private readonly listeners = new Set<ThemeListener>();
  private readonly storage?: StorageAdapter;

  constructor(options: ThemeProviderOptions = {}) {
    this.storage = options.storage;
    this.current = options.initial ?? detectPreferredTheme(options.detect);
  }

  /** Load a persisted choice (if any) and adopt it. Call once after construction. */
  async hydrate(): Promise<void> {
    if (!this.storage) {
      return;
    }
    const saved = await this.storage.get(STORAGE_KEY);
    if (saved === 'osiris-dark' || saved === 'osiris-light') {
      this.setTheme(saved);
    }
  }

  get theme(): OsirisTheme {
    return this.current;
  }

  get workbenchColorTheme(): string {
    return LABELS[this.current];
  }

  /** The accent colours for the active theme, from `@osiris/branding`. */
  get accents(): { primary: string; secondary: string } {
    return { primary: metadata.colors.accent, secondary: metadata.colors.accentAlt };
  }

  setTheme(next: OsirisTheme): void {
    if (next === this.current) {
      return;
    }
    this.current = next;
    void this.storage?.set(STORAGE_KEY, next);
    for (const listener of this.listeners) {
      listener(next);
    }
  }

  toggle(): void {
    this.setTheme(this.current === 'osiris-dark' ? 'osiris-light' : 'osiris-dark');
  }

  onDidChange(listener: ThemeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.listeners.clear();
  }
}
