import { describe, expect, it } from 'vitest';
import { chunkMarkdown } from '../src/chunk.js';

describe('chunkMarkdown', () => {
  it('splits on heading boundaries and carries the breadcrumb', () => {
    const md = [
      '# Title',
      '',
      'Intro paragraph.',
      '',
      '## Section A',
      '',
      'Body of A.',
      '',
      '## Section B',
      '',
      'Body of B.',
    ].join('\n');
    const chunks = chunkMarkdown(md, { chunkSize: 200 });
    expect(chunks).toHaveLength(3);
    expect(chunks[1]!.headingPath).toEqual(['Title', 'Section A']);
    expect(chunks[1]!.text.startsWith('Title > Section A')).toBe(true);
    expect(chunks[2]!.text).toContain('Body of B.');
  });

  it('further splits an oversized section with overlap', () => {
    const long = Array.from({ length: 40 }, (_, i) => `Paragraph number ${i} with some filler text.`).join(
      '\n\n',
    );
    const chunks = chunkMarkdown(`# H\n\n${long}`, { chunkSize: 300, chunkOverlap: 60 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.headingPath[0] === 'H')).toBe(true);
    expect(chunks.every((c, i) => c.index === i)).toBe(true);
  });

  it('returns nothing for whitespace-only input', () => {
    expect(chunkMarkdown('   \n\n  ')).toEqual([]);
  });
});
