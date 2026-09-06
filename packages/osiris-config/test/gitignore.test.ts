import { describe, expect, it } from 'vitest';
import { withOsirisGitignore } from '../src/gitignore.js';

describe('withOsirisGitignore', () => {
  it('adds the temp entry to a missing file', () => {
    const next = withOsirisGitignore(undefined);
    expect(next).toContain('.osiris/temp/');
    expect(next?.endsWith('\n')).toBe(true);
  });

  it('appends to an existing file without a trailing newline', () => {
    const next = withOsirisGitignore('node_modules/');
    expect(next).toBe(
      'node_modules/\n\n# Osiris — agent scratchpads, never committed\n.osiris/temp/\n',
    );
  });

  it('is a no-op when the entry is already present', () => {
    expect(withOsirisGitignore('foo\n.osiris/temp/\nbar\n')).toBeNull();
  });
});
