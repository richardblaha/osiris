import { describe, expect, it } from 'vitest';
import { parseFrontmatter, serializeFrontmatter } from '../src/frontmatter.js';
import { parseAgentDefinition, serializeAgentDefinition } from '../src/definition.js';

describe('parseFrontmatter', () => {
  it('reads scalars, quoted strings and inline arrays', () => {
    const { data, body } = parseFrontmatter(
      ['---', 'name: architect', 'temperature: 0.2', 'tools: [a, b, c]', 'flag: true', '---', '', 'Body.'].join(
        '\n',
      ),
    );
    expect(data).toEqual({ name: 'architect', temperature: 0.2, tools: ['a', 'b', 'c'], flag: true });
    expect(body.trim()).toBe('Body.');
  });

  it('returns the whole input when there is no frontmatter', () => {
    expect(parseFrontmatter('# Just markdown')).toEqual({ data: {}, body: '# Just markdown' });
  });
});

describe('parseAgentDefinition', () => {
  const good = [
    '---',
    'name: implementer',
    'role: Engineer',
    'specialization: code',
    'model: vscode-lm/claude-sonnet-5',
    'tools: [read_file]',
    'delegateTo: []',
    '---',
    '',
    'Do the work.',
  ].join('\n');

  it('round-trips every field', () => {
    const parsed = parseAgentDefinition(good, 'implementer.md');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.name).toBe('implementer');
    expect(parsed.value.tools).toEqual(['read_file']);
    expect(parsed.value.instructions).toBe('Do the work.');

    const reparsed = parseAgentDefinition(serializeAgentDefinition(parsed.value));
    expect(reparsed.ok && reparsed.value).toEqual(parsed.value);
  });

  it('rejects a file with no frontmatter, citing the path', () => {
    const parsed = parseAgentDefinition('just a prompt', 'broken.md');
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.message).toContain('broken.md');
  });

  it('rejects an invalid field', () => {
    const parsed = parseAgentDefinition('---\nname: Bad Name\nrole: x\n---\nbody');
    expect(parsed.ok).toBe(false);
  });
});
