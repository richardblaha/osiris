/**
 * Parser for ISO 10303-21 exchange files. Consumes the token stream from
 * {@link "./tokenizer".tokenize} and produces a {@link StepModel}: the parsed
 * header plus every `DATA` entity indexed by id, with forward references
 * resolved lazily through {@link StepModel.getEntity}.
 */
import {
  err,
  ok,
  type Result,
  type StepEntity,
  type StepHeader,
  type StepValue,
} from '@osiris/shared-core';
import { StepTokenizeError, tokenize, type Token } from './tokenizer.js';

export class StepParseError extends Error {
  constructor(
    message: string,
    readonly line?: number,
    readonly column?: number,
  ) {
    super(message);
    this.name = 'StepParseError';
  }
}

export interface StepModel {
  header: StepHeader;
  /** Every DATA entity, keyed by its numeric id. */
  entities: Map<number, StepEntity>;
  getEntity(id: number): StepEntity | undefined;
  byType(type: string): StepEntity[];
  readonly schemaIdentifiers: string[];
}

const EMPTY_HEADER: StepHeader = {
  description: [],
  implementationLevel: '',
  name: '',
  timeStamp: '',
  author: [],
  organization: [],
  preprocessorVersion: '',
  originatingSystem: '',
  authorization: '',
  schemaIdentifiers: [],
};

class Cursor {
  private pos = 0;
  constructor(private readonly tokens: Token[]) {}

  peek(): Token {
    return this.tokens[this.pos]!;
  }

  next(): Token {
    return this.tokens[this.pos++]!;
  }

  expect(type: Token['type']): Token {
    const token = this.peek();
    if (token.type !== type) {
      throw new StepParseError(
        `Expected ${type} but found ${token.type} "${token.value}"`,
        token.line,
        token.column,
      );
    }
    return this.next();
  }

  atEnd(): boolean {
    return this.peek().type === 'eof';
  }
}

/** Parse a parameter list assuming the opening `(` has NOT yet been consumed. */
function parseParameterList(cursor: Cursor): StepValue[] {
  cursor.expect('lparen');
  const params: StepValue[] = [];
  if (cursor.peek().type === 'rparen') {
    cursor.next();
    return params;
  }
  for (;;) {
    params.push(parseValue(cursor));
    const sep = cursor.next();
    if (sep.type === 'rparen') {
      break;
    }
    if (sep.type !== 'comma') {
      throw new StepParseError(
        `Expected "," or ")" in parameter list, found "${sep.value}"`,
        sep.line,
        sep.column,
      );
    }
  }
  return params;
}

function parseValue(cursor: Cursor): StepValue {
  const token = cursor.peek();
  switch (token.type) {
    case 'integer':
      cursor.next();
      return { kind: 'number', value: token.num ?? Number(token.value) };
    case 'real':
      cursor.next();
      return { kind: 'number', value: token.num ?? Number(token.value) };
    case 'string':
      cursor.next();
      return { kind: 'string', value: token.value };
    case 'binary':
      cursor.next();
      return { kind: 'string', value: token.value };
    case 'entityRef':
      cursor.next();
      return { kind: 'ref', id: token.num! };
    case 'enum':
      cursor.next();
      return { kind: 'enum', value: token.value };
    case 'boolean':
      cursor.next();
      return { kind: 'boolean', value: token.num === 1 };
    case 'undefinedLogical':
      cursor.next();
      return { kind: 'null' };
    case 'dollar':
      cursor.next();
      return { kind: 'null' };
    case 'star':
      cursor.next();
      return { kind: 'derived' };
    case 'lparen':
      return { kind: 'list', items: parseParameterList(cursor) };
    case 'keyword': {
      // Typed parameter, e.g. LENGTH_MEASURE(1.0)
      cursor.next();
      const inner = parseParameterList(cursor);
      const value: StepValue = inner.length === 1 ? inner[0]! : { kind: 'list', items: inner };
      return { kind: 'typed', typeName: token.value, value };
    }
    default:
      throw new StepParseError(
        `Unexpected token "${token.value}" (${token.type}) in parameter list`,
        token.line,
        token.column,
      );
  }
}

function stringOf(value: StepValue | undefined): string {
  return value?.kind === 'string' ? value.value : '';
}

function stringListOf(value: StepValue | undefined): string[] {
  if (value?.kind === 'list') {
    return value.items
      .filter((v) => v.kind === 'string')
      .map((v) => (v as { value: string }).value);
  }
  return value?.kind === 'string' ? [value.value] : [];
}

function buildHeader(headerEntities: { type: string; params: StepValue[] }[]): StepHeader {
  const header: StepHeader = { ...EMPTY_HEADER };
  for (const entity of headerEntities) {
    const p = entity.params;
    switch (entity.type) {
      case 'FILE_DESCRIPTION':
        header.description = stringListOf(p[0]);
        header.implementationLevel = stringOf(p[1]);
        break;
      case 'FILE_NAME':
        header.name = stringOf(p[0]);
        header.timeStamp = stringOf(p[1]);
        header.author = stringListOf(p[2]);
        header.organization = stringListOf(p[3]);
        header.preprocessorVersion = stringOf(p[4]);
        header.originatingSystem = stringOf(p[5]);
        header.authorization = stringOf(p[6]);
        break;
      case 'FILE_SCHEMA':
        header.schemaIdentifiers = stringListOf(p[0]);
        break;
      default:
        break;
    }
  }
  return header;
}

export function parseStep(source: string): Result<StepModel, StepParseError> {
  let tokens: Token[];
  try {
    tokens = tokenize(source);
  } catch (cause) {
    if (cause instanceof StepTokenizeError) {
      return err(new StepParseError(cause.message, cause.line, cause.column));
    }
    return err(new StepParseError(`Tokenization failed: ${(cause as Error).message}`));
  }

  const cursor = new Cursor(tokens);

  try {
    // Envelope: ISO-10303-21 ;
    const first = cursor.expect('keyword');
    if (first.value !== 'ISO-10303-21') {
      return err(
        new StepParseError(
          `Expected "ISO-10303-21;" preamble, found "${first.value}"`,
          first.line,
          first.column,
        ),
      );
    }
    cursor.expect('semicolon');

    const headerEntities: { type: string; params: StepValue[] }[] = [];
    const entities = new Map<number, StepEntity>();

    let section: 'none' | 'header' | 'data' = 'none';

    while (!cursor.atEnd()) {
      const token = cursor.peek();

      if (token.type === 'keyword' && token.value === 'HEADER') {
        cursor.next();
        cursor.expect('semicolon');
        section = 'header';
        continue;
      }
      if (token.type === 'keyword' && token.value === 'DATA') {
        cursor.next();
        // DATA can be `DATA;` or `DATA(...)` in later editions; tolerate a list.
        if (cursor.peek().type === 'lparen') {
          parseParameterList(cursor);
        }
        cursor.expect('semicolon');
        section = 'data';
        continue;
      }
      if (token.type === 'keyword' && token.value === 'ENDSEC') {
        cursor.next();
        cursor.expect('semicolon');
        section = 'none';
        continue;
      }
      if (token.type === 'keyword' && token.value === 'END-ISO-10303-21') {
        cursor.next();
        if (cursor.peek().type === 'semicolon') {
          cursor.next();
        }
        break;
      }

      if (section === 'header') {
        const type = cursor.expect('keyword').value;
        const params = parseParameterList(cursor);
        cursor.expect('semicolon');
        headerEntities.push({ type, params });
        continue;
      }

      if (section === 'data') {
        const idToken = cursor.expect('entityId');
        cursor.expect('equals');
        // A single entity or a complex-instance list of typed records.
        const recordType = cursor.peek();
        if (recordType.type === 'lparen') {
          // Complex instance: ( TYPE(...) TYPE(...) ) — merge into the first type.
          cursor.next();
          let merged: StepEntity | undefined;
          while (cursor.peek().type !== 'rparen') {
            const t = cursor.expect('keyword').value;
            const params = parseParameterList(cursor);
            if (!merged) {
              merged = { id: idToken.num!, type: t, parameters: params };
            } else {
              merged.parameters.push({
                kind: 'typed',
                typeName: t,
                value: { kind: 'list', items: params },
              });
            }
          }
          cursor.expect('rparen');
          cursor.expect('semicolon');
          if (merged) {
            entities.set(merged.id, merged);
          }
          continue;
        }
        const type = cursor.expect('keyword').value;
        const params = parseParameterList(cursor);
        cursor.expect('semicolon');
        entities.set(idToken.num!, { id: idToken.num!, type, parameters: params });
        continue;
      }

      // Stray token outside any section — skip defensively.
      cursor.next();
    }

    const header = buildHeader(headerEntities);
    const byTypeCache = new Map<string, StepEntity[]>();

    const model: StepModel = {
      header,
      entities,
      schemaIdentifiers: header.schemaIdentifiers,
      getEntity: (id) => entities.get(id),
      byType: (type) => {
        const key = type.toUpperCase();
        let cached = byTypeCache.get(key);
        if (!cached) {
          cached = [...entities.values()].filter((e) => e.type.toUpperCase() === key);
          byTypeCache.set(key, cached);
        }
        return cached;
      },
    };

    return ok(model);
  } catch (cause) {
    if (cause instanceof StepParseError) {
      return err(cause);
    }
    return err(new StepParseError(`Parse failed: ${(cause as Error).message}`));
  }
}
