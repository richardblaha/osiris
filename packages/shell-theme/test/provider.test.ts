import { describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '../src/provider.js';
import type { StorageAdapter } from '../src/provider.js';

function memoryStorage(
  seed: Record<string, string> = {},
): StorageAdapter & { data: Map<string, string> } {
  const data = new Map(Object.entries(seed));
  return {
    data,
    get: (k) => data.get(k) ?? null,
    set: (k, v) => void data.set(k, v),
  };
}

describe('ThemeProvider', () => {
  it('starts from the explicit initial theme', () => {
    const p = new ThemeProvider({ initial: 'osiris-light' });
    expect(p.theme).toBe('osiris-light');
    expect(p.workbenchColorTheme).toBe('Osiris Light');
  });

  it('notifies listeners on change and not on no-op', () => {
    const p = new ThemeProvider({ initial: 'osiris-dark' });
    const listener = vi.fn();
    p.onDidChange(listener);
    p.setTheme('osiris-dark');
    expect(listener).not.toHaveBeenCalled();
    p.setTheme('osiris-light');
    expect(listener).toHaveBeenCalledWith('osiris-light');
  });

  it('toggle flips between the two themes', () => {
    const p = new ThemeProvider({ initial: 'osiris-dark' });
    p.toggle();
    expect(p.theme).toBe('osiris-light');
    p.toggle();
    expect(p.theme).toBe('osiris-dark');
  });

  it('persists the choice through the storage adapter', () => {
    const storage = memoryStorage();
    const p = new ThemeProvider({ initial: 'osiris-dark', storage });
    p.setTheme('osiris-light');
    expect(storage.data.get('osiris.shell-theme')).toBe('osiris-light');
  });

  it('hydrate adopts a persisted choice', async () => {
    const storage = memoryStorage({ 'osiris.shell-theme': 'osiris-light' });
    const p = new ThemeProvider({ initial: 'osiris-dark', storage });
    await p.hydrate();
    expect(p.theme).toBe('osiris-light');
  });

  it('exposes branding accent colours', () => {
    const p = new ThemeProvider({ initial: 'osiris-dark' });
    expect(p.accents).toEqual({ primary: '#00FFFF', secondary: '#FF00FF' });
  });
});
