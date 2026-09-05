import { type Result, err, ok } from '@richardblaha/shared-core';
import { BacklogTask, TaskFrontmatter } from '@richardblaha/protocol';

/** `[<type>]-<id>-<slug>.md` — id zero-padded to at least 4 digits. */
const FILENAME = /^\[([a-z][a-z0-9]*)\]-(\d{1,})-([a-z0-9][a-z0-9-]*)\.md$/;

export interface ParsedFilename {
  type: string;
  id: number;
  slug: string;
}

export function parseTaskFilename(filename: string): ParsedFilename | undefined {
  const match = FILENAME.exec(filename);
  if (!match) return undefined;
  return { type: match[1]!, id: Number(match[2]), slug: match[3]! };
}

export function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'task'
  );
}

export function formatTaskFilename(type: string, id: number, slug: string): string {
  return `[${type}]-${String(id).padStart(4, '0')}-${slug}.md`;
}

interface FrontmatterBlock {
  data: Record<string, unknown>;
  body: string;
}

function readFrontmatter(source: string): FrontmatterBlock {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source);
  if (!match) return { data: {}, body: source };
  const data: Record<string, unknown> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon === -1 || !line.trim() || line.trimStart().startsWith('#')) continue;
    const key = line.slice(0, colon).trim();
    const raw = line.slice(colon + 1).trim();
    if (raw.startsWith('[') && raw.endsWith(']')) {
      const inner = raw.slice(1, -1).trim();
      data[key] = inner ? inner.split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')) : [];
    } else if (/^-?\d+$/.test(raw)) {
      data[key] = Number(raw);
    } else {
      data[key] = raw.replace(/^["']|["']$/g, '');
    }
  }
  return { data, body: source.slice(match[0].length) };
}

function writeFrontmatter(data: Record<string, unknown>, body: string): string {
  const line = (k: string, v: unknown): string => {
    if (Array.isArray(v)) return `${k}: [${v.join(', ')}]`;
    return `${k}: ${String(v)}`;
  };
  const keys = ['id', 'type', 'title', 'assignee', 'labels', 'created'].filter(
    (k) => data[k] !== undefined,
  );
  return `---\n${keys.map((k) => line(k, data[k])).join('\n')}\n---\n\n${body.replace(/^\n+/, '')}`;
}

export interface ParseTaskError {
  filename: string;
  message: string;
}

/** Parse a task file (frontmatter + body) living in `state`. */
export function parseTaskFile(
  state: string,
  filename: string,
  content: string,
): Result<BacklogTask, ParseTaskError> {
  const fromName = parseTaskFilename(filename);
  if (!fromName) {
    return err({ filename, message: `filename does not match [<type>]-<id>-<slug>.md` });
  }
  const { data, body } = readFrontmatter(content);
  const fm = TaskFrontmatter.safeParse({
    id: data.id ?? fromName.id,
    type: data.type ?? fromName.type,
    title: data.title ?? fromName.slug.replace(/-/g, ' '),
    assignee: data.assignee,
    labels: data.labels ?? [],
    created: data.created,
  });
  if (!fm.success) {
    return err({ filename, message: fm.error.issues.map((i) => i.message).join('; ') });
  }
  return ok(
    BacklogTask.parse({
      id: fromName.id,
      type: fromName.type,
      slug: fromName.slug,
      title: fm.data.title,
      state,
      filename,
      assignee: fm.data.assignee,
      labels: fm.data.labels,
      created: fm.data.created,
      body: body.trim(),
    }),
  );
}

export interface NewTaskInput {
  type: string;
  id: number;
  title: string;
  assignee?: string;
  labels?: string[];
  created?: string;
  body?: string;
}

/** Produce `{ filename, content }` for a brand-new task. */
export function renderNewTask(input: NewTaskInput): { filename: string; content: string } {
  const slug = slugify(input.title);
  const filename = formatTaskFilename(input.type, input.id, slug);
  const created = input.created ?? new Date().toISOString().slice(0, 10);
  const content = writeFrontmatter(
    {
      id: input.id,
      type: input.type,
      title: input.title,
      assignee: input.assignee,
      labels: input.labels ?? [],
      created,
    },
    input.body?.trim()
      ? `${input.body.trim()}\n`
      : `## Context\n\n_TODO_\n\n## Acceptance criteria\n\n- [ ] _TODO_\n`,
  );
  return { filename, content };
}
