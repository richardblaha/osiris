/**
 * A deliberately small YAML-frontmatter reader — enough for `.osiris/agents/*.md`
 * headers: scalars (string / number / boolean), quoted strings and inline
 * `[a, b, c]` arrays. No nesting, no anchors, no multi-line. Avoids a YAML dep.
 */

export interface Frontmatter {
  data: Record<string, unknown>;
  body: string;
}

function coerce(raw: string): unknown {
  const value = raw.trim();
  if (value === '') return '';
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim();
    if (inner === '') return [];
    return inner.split(',').map((item) => coerce(item));
  }
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null' || value === '~') return null;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}

/**
 * Split a `---` fenced frontmatter block off the top of a document. When there is
 * no frontmatter, `data` is `{}` and `body` is the whole input.
 */
export function parseFrontmatter(source: string): Frontmatter {
  const normalised = source.replace(/^\uFEFF/, '');
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(normalised);
  if (!match) return { data: {}, body: normalised };

  const data: Record<string, unknown> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    if (!key) continue;
    data[key] = coerce(line.slice(colon + 1));
  }
  return { data, body: normalised.slice(match[0].length) };
}

function serializeValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => serializeValue(v)).join(', ')}]`;
  if (typeof value === 'string')
    return /[:#[\]]|^\s|\s$/.test(value) ? JSON.stringify(value) : value;
  return String(value);
}

/** Render a frontmatter block + body. Keys are emitted in `order`, then the rest. */
export function serializeFrontmatter(
  data: Record<string, unknown>,
  body: string,
  order: string[] = [],
): string {
  const keys = [
    ...order.filter((k) => k in data),
    ...Object.keys(data).filter((k) => !order.includes(k)),
  ];
  const lines = keys
    .filter((k) => data[k] !== undefined)
    .map((k) => `${k}: ${serializeValue(data[k])}`);
  return `---\n${lines.join('\n')}\n---\n\n${body.replace(/^\n+/, '')}`;
}
