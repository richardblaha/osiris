import { describe, expect, it } from 'vitest';
import { err, isErr, isOk, mapResult, ok, unwrap, unwrapOr } from '../src/result.js';

describe('result', () => {
  it('constructs ok / err', () => {
    expect(ok(1)).toEqual({ ok: true, value: 1 });
    expect(err('boom')).toEqual({ ok: false, error: 'boom' });
  });

  it('narrows with isOk / isErr', () => {
    const r = ok(42);
    expect(isOk(r)).toBe(true);
    expect(isErr(r)).toBe(false);
  });

  it('unwrap returns value or throws', () => {
    expect(unwrap(ok('x'))).toBe('x');
    expect(() => unwrap(err(new Error('nope')))).toThrow('nope');
    expect(() => unwrap(err('string-error'))).toThrow('string-error');
  });

  it('unwrapOr falls back', () => {
    expect(unwrapOr(ok(1), 9)).toBe(1);
    expect(unwrapOr(err('e') as ReturnType<typeof err<string>>, 9)).toBe(9);
  });

  it('mapResult maps success only', () => {
    expect(mapResult(ok(2), (n) => n * 3)).toEqual(ok(6));
    const e = err('e');
    expect(mapResult(e, (n: number) => n * 3)).toBe(e);
  });
});
