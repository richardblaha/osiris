import { describe, expect, it } from 'vitest';
import {
  formatTaskFilename,
  parseTaskFile,
  parseTaskFilename,
  renderNewTask,
  slugify,
} from '../src/task.js';

describe('task filenames', () => {
  it('parses and formats [<type>]-<id>-<slug>.md', () => {
    expect(parseTaskFilename('[bug]-0101-parser-crash.md')).toEqual({
      type: 'bug',
      id: 101,
      slug: 'parser-crash',
    });
    expect(formatTaskFilename('bug', 101, 'parser-crash')).toBe('[bug]-0101-parser-crash.md');
  });

  it('rejects a malformed name', () => {
    expect(parseTaskFilename('bug-1-x.md')).toBeUndefined();
    expect(parseTaskFilename('[Bug]-1-x.md')).toBeUndefined();
  });

  it('slugifies titles', () => {
    expect(slugify('DEXPI parser crashes on <Tag>!')).toBe('dexpi-parser-crashes-on-tag');
    expect(slugify('')).toBe('task');
  });
});

describe('parseTaskFile', () => {
  it('merges filename + frontmatter into a BacklogTask', () => {
    const content = [
      '---',
      'id: 101',
      'type: bug',
      'title: Parser crash',
      'labels: [dexpi, parser]',
      'created: 2026-09-02',
      '---',
      '',
      '## Context',
      'boom',
    ].join('\n');
    const parsed = parseTaskFile('todo', '[bug]-0101-parser-crash.md', content);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toMatchObject({
      id: 101,
      type: 'bug',
      slug: 'parser-crash',
      state: 'todo',
      title: 'Parser crash',
      labels: ['dexpi', 'parser'],
    });
    expect(parsed.value.body).toContain('boom');
  });

  it('falls back to the filename when frontmatter is thin', () => {
    const parsed = parseTaskFile('done', '[chore]-0007-tidy-up.md', 'no frontmatter body');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.title).toBe('tidy up');
  });

  it('errors on a bad filename', () => {
    expect(parseTaskFile('todo', 'notes.md', 'x').ok).toBe(false);
  });
});

describe('renderNewTask', () => {
  it('produces a valid, re-parseable file', () => {
    const { filename, content } = renderNewTask({ type: 'feat', id: 3, title: 'Add Kanban drag' });
    expect(filename).toBe('[feat]-0003-add-kanban-drag.md');
    const reparsed = parseTaskFile('todo', filename, content);
    expect(reparsed.ok).toBe(true);
    if (reparsed.ok) expect(reparsed.value.title).toBe('Add Kanban drag');
  });
});
