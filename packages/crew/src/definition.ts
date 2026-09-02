import { type Result, err, ok } from '@osiris/shared-core';
import { AgentDefinition } from '@osiris/protocol';
import { parseFrontmatter, serializeFrontmatter } from './frontmatter.js';

const FIELD_ORDER = [
  'name',
  'role',
  'specialization',
  'model',
  'taskClass',
  'tools',
  'delegateTo',
  'temperature',
];

export interface ParseAgentError {
  path?: string;
  message: string;
}

/**
 * Parse an `.osiris/agents/<name>.md` file. The YAML frontmatter carries the
 * agent's identity and capabilities; the Markdown body is its system prompt.
 */
export function parseAgentDefinition(
  source: string,
  path?: string,
): Result<AgentDefinition, ParseAgentError> {
  const { data, body } = parseFrontmatter(source);
  if (Object.keys(data).length === 0) {
    return err({
      path,
      message: `no YAML frontmatter in agent definition${path ? ` ${path}` : ''}`,
    });
  }
  const parsed = AgentDefinition.safeParse({ ...data, instructions: body.trim() });
  if (!parsed.success) {
    return err({
      path,
      message: `invalid agent definition${path ? ` ${path}` : ''}: ${parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'} ${i.message}`)
        .join('; ')}`,
    });
  }
  return ok(parsed.data);
}

/** Render an `AgentDefinition` back to `.md` form. */
export function serializeAgentDefinition(def: AgentDefinition): string {
  const { instructions, ...frontmatter } = def;
  return serializeFrontmatter(
    frontmatter as Record<string, unknown>,
    `${instructions}\n`,
    FIELD_ORDER,
  );
}
