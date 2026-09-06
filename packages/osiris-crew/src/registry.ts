import { createLogger } from '@richardblaha/osiris-core';
import { type OsirisPaths, listOsirisDir, resolveOsirisFile } from '@richardblaha/osiris-config';
import type { AgentDefinition } from '@richardblaha/osiris-protocol';
import { parseAgentDefinition } from './definition.js';

const log = createLogger('crew:registry');

/** An immutable set of the crew's agents, keyed by `name`. */
export class AgentRegistry {
  private readonly agents: Map<string, AgentDefinition>;

  constructor(agents: AgentDefinition[]) {
    this.agents = new Map(agents.map((a) => [a.name, a]));
  }

  get(name: string): AgentDefinition | undefined {
    return this.agents.get(name);
  }

  require(name: string): AgentDefinition {
    const agent = this.agents.get(name);
    if (!agent) {
      throw new Error(
        `unknown agent "${name}" (have: ${[...this.agents.keys()].join(', ') || 'none'})`,
      );
    }
    return agent;
  }

  has(name: string): boolean {
    return this.agents.has(name);
  }

  list(): AgentDefinition[] {
    return [...this.agents.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
}

/**
 * Load every `.osiris/agents/*.md` (project files shadow the bundled template),
 * skipping — with a warning — any file that fails to parse.
 */
export async function loadAgentRegistry(paths: OsirisPaths): Promise<AgentRegistry> {
  const files = await listOsirisDir(paths, 'agents', {
    recursive: true,
    filter: (rel) => rel.endsWith('.md') && !rel.endsWith('README.md'),
  });
  const defs: AgentDefinition[] = [];
  for (const file of files) {
    const resolved = await resolveOsirisFile(paths, `agents/${file.relPath}`);
    if (!resolved) continue;
    const parsed = parseAgentDefinition(resolved.content, resolved.path);
    if (parsed.ok) defs.push(parsed.value);
    else log.warn('skipping %s: %s', file.relPath, parsed.error.message);
  }
  log.info('loaded %d agent(s): %s', defs.length, defs.map((d) => d.name).join(', '));
  return new AgentRegistry(defs);
}
