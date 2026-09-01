import { describe, expect, it } from 'vitest';
import { tokenize, StepTokenizeError } from '../src/parser/tokenizer.js';

describe('tokenize', () => {
  it('distinguishes entity definitions from references', () => {
    const tokens = tokenize('#10 = CARTESIAN_POINT(#20);');
    expect(tokens.map((t) => t.type)).toEqual([
      'entityId',
      'equals',
      'keyword',
      'lparen',
      'entityRef',
      'rparen',
      'semicolon',
      'eof',
    ]);
    expect(tokens[0]?.num).toBe(10);
    expect(tokens[4]?.num).toBe(20);
  });

  it('parses reals, integers and scientific notation', () => {
    const tokens = tokenize('(1, 2.5, -3.0, 1.5E1, 4.2e-3)');
    const nums = tokens.filter((t) => t.type === 'real' || t.type === 'integer').map((t) => t.num);
    expect(nums).toEqual([1, 2.5, -3.0, 15, 0.0042]);
    expect(tokens.find((t) => t.value === '1')?.type).toBe('integer');
  });

  it('handles quoted strings with doubled-quote escapes', () => {
    const tokens = tokenize("A('it''s fine');");
    const str = tokens.find((t) => t.type === 'string');
    expect(str?.value).toBe("it's fine");
  });

  it('recognizes enums, booleans and logical unknown', () => {
    const tokens = tokenize('X(.STEEL., .T., .F., .U.)');
    expect(tokens.filter((t) => t.type === 'enum').map((t) => t.value)).toEqual(['STEEL']);
    expect(tokens.filter((t) => t.type === 'boolean').map((t) => t.num)).toEqual([1, 0]);
    expect(tokens.some((t) => t.type === 'undefinedLogical')).toBe(true);
  });

  it('skips block comments and tracks line numbers', () => {
    const tokens = tokenize('/* c\nomment */\n#1 = A();');
    expect(tokens[0]?.type).toBe('entityId');
    expect(tokens[0]?.line).toBe(3);
  });

  it('throws on an unterminated string', () => {
    expect(() => tokenize("A('oops")).toThrow(StepTokenizeError);
  });
});
