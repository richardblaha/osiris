/**
 * Lexer for ISO 10303-21 (STEP Part 21) exchange files.
 *
 * Emits a flat token stream that {@link "../parser/stepParser".parseStep}
 * turns into entities. Handles: `#id` references and definitions, integers,
 * reals, `'…'` strings (with `''` escapes), `.ENUM.` values, `$` (null),
 * `*` (derived), binary `"…"`, punctuation, and `/* … *\/` comments.
 */

export type TokenType =
  | 'keyword' // TYPE_NAME or ISO-10303-21 / HEADER / DATA / ENDSEC / …
  | 'entityRef' // #123 used as a value
  | 'entityId' // #123 on the left-hand side of `=`
  | 'integer'
  | 'real'
  | 'string'
  | 'binary'
  | 'enum' // .SOME_ENUM.
  | 'boolean' // .T. / .F.
  | 'undefinedLogical' // .U.
  | 'dollar' // $
  | 'star' // *
  | 'lparen'
  | 'rparen'
  | 'comma'
  | 'equals'
  | 'semicolon'
  | 'eof';

export interface Token {
  type: TokenType;
  /** Raw lexeme, already unescaped for strings. */
  value: string;
  /** Numeric value for integer/real/entityRef/entityId tokens. */
  num?: number;
  offset: number;
  line: number;
  column: number;
}

export class StepTokenizeError extends Error {
  constructor(
    message: string,
    readonly line: number,
    readonly column: number,
  ) {
    super(`${message} (line ${line}, column ${column})`);
    this.name = 'StepTokenizeError';
  }
}

const KEYWORD_START = /[A-Za-z_]/;
const KEYWORD_CHAR = /[A-Za-z0-9_-]/;
const DIGIT = /[0-9]/;

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let lineStart = 0;

  const column = (): number => i - lineStart + 1;
  const push = (
    type: TokenType,
    value: string,
    startOffset: number,
    startLine: number,
    startCol: number,
    num?: number,
  ): void => {
    tokens.push({ type, value, num, offset: startOffset, line: startLine, column: startCol });
  };

  const advanceNewlines = (from: number, to: number): void => {
    for (let k = from; k < to; k++) {
      if (source.charCodeAt(k) === 10) {
        line++;
        lineStart = k + 1;
      }
    }
  };

  while (i < source.length) {
    const ch = source[i]!;

    // Whitespace
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      if (ch === '\n') {
        line++;
        lineStart = i + 1;
      }
      i++;
      continue;
    }

    // Comment /* ... */
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      if (end < 0) {
        throw new StepTokenizeError('Unterminated comment', line, column());
      }
      advanceNewlines(i, end + 2);
      i = end + 2;
      continue;
    }

    const startOffset = i;
    const startLine = line;
    const startCol = column();

    switch (ch) {
      case '(':
        push('lparen', '(', startOffset, startLine, startCol);
        i++;
        continue;
      case ')':
        push('rparen', ')', startOffset, startLine, startCol);
        i++;
        continue;
      case ',':
        push('comma', ',', startOffset, startLine, startCol);
        i++;
        continue;
      case '=':
        push('equals', '=', startOffset, startLine, startCol);
        i++;
        continue;
      case ';':
        push('semicolon', ';', startOffset, startLine, startCol);
        i++;
        continue;
      case '$':
        push('dollar', '$', startOffset, startLine, startCol);
        i++;
        continue;
      case '*':
        push('star', '*', startOffset, startLine, startCol);
        i++;
        continue;
      default:
        break;
    }

    // String literal '...'
    if (ch === "'") {
      i++;
      let out = '';
      while (i < source.length) {
        const c = source[i]!;
        if (c === "'") {
          if (source[i + 1] === "'") {
            out += "'";
            i += 2;
            continue;
          }
          i++;
          push('string', out, startOffset, startLine, startCol);
          break;
        }
        if (c === '\n') {
          line++;
          lineStart = i + 1;
        }
        out += c;
        i++;
      }
      if (source[i - 1] !== "'") {
        throw new StepTokenizeError('Unterminated string', startLine, startCol);
      }
      continue;
    }

    // Binary "..."
    if (ch === '"') {
      const end = source.indexOf('"', i + 1);
      if (end < 0) {
        throw new StepTokenizeError('Unterminated binary literal', startLine, startCol);
      }
      push('binary', source.slice(i + 1, end), startOffset, startLine, startCol);
      i = end + 1;
      continue;
    }

    // Enumeration / boolean / logical: .NAME.
    if (ch === '.') {
      const end = source.indexOf('.', i + 1);
      if (end < 0) {
        throw new StepTokenizeError('Unterminated enumeration', startLine, startCol);
      }
      const name = source.slice(i + 1, end);
      i = end + 1;
      if (name === 'T' || name === 'F') {
        push('boolean', name, startOffset, startLine, startCol, name === 'T' ? 1 : 0);
      } else if (name === 'U') {
        push('undefinedLogical', name, startOffset, startLine, startCol);
      } else {
        push('enum', name, startOffset, startLine, startCol);
      }
      continue;
    }

    // Entity id / ref: #123
    if (ch === '#') {
      let j = i + 1;
      while (j < source.length && DIGIT.test(source[j]!)) {
        j++;
      }
      if (j === i + 1) {
        throw new StepTokenizeError('Expected digits after "#"', startLine, startCol);
      }
      const id = Number(source.slice(i + 1, j));
      // Look ahead past whitespace for "=" to decide id vs ref.
      let k = j;
      while (k < source.length && /\s/.test(source[k]!)) {
        k++;
      }
      const type: TokenType = source[k] === '=' ? 'entityId' : 'entityRef';
      push(type, `#${id}`, startOffset, startLine, startCol, id);
      i = j;
      continue;
    }

    // Number: [+-]?digits(.digits)?(E[+-]?digits)?
    if (DIGIT.test(ch) || ((ch === '+' || ch === '-') && DIGIT.test(source[i + 1] ?? ''))) {
      let j = i + 1;
      let isReal = false;
      while (j < source.length) {
        const c = source[j]!;
        if (DIGIT.test(c)) {
          j++;
        } else if (c === '.') {
          isReal = true;
          j++;
        } else if (c === 'E' || c === 'e') {
          isReal = true;
          j++;
          if (source[j] === '+' || source[j] === '-') {
            j++;
          }
        } else {
          break;
        }
      }
      const raw = source.slice(i, j);
      const value = Number(raw);
      if (Number.isNaN(value)) {
        throw new StepTokenizeError(`Invalid number "${raw}"`, startLine, startCol);
      }
      push(isReal ? 'real' : 'integer', raw, startOffset, startLine, startCol, value);
      i = j;
      continue;
    }

    // Keyword / type name
    if (KEYWORD_START.test(ch)) {
      let j = i + 1;
      while (j < source.length && KEYWORD_CHAR.test(source[j]!)) {
        j++;
      }
      push('keyword', source.slice(i, j), startOffset, startLine, startCol);
      i = j;
      continue;
    }

    throw new StepTokenizeError(`Unexpected character "${ch}"`, startLine, startCol);
  }

  push('eof', '', i, line, column());
  return tokens;
}
