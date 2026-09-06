import type { BlackboardEntry } from '@richardblaha/osiris-protocol';

/**
 * The crew's shared working memory for one run: an append-only log of decisions,
 * findings and results that every agent's system prompt is primed with.
 */
export class Blackboard {
  private readonly log: BlackboardEntry[] = [];

  constructor(private readonly onAdd?: (entry: BlackboardEntry) => void) {}

  add(agent: string, kind: BlackboardEntry['kind'], text: string): BlackboardEntry {
    const entry: BlackboardEntry = { agent, kind, text: text.trim(), at: new Date().toISOString() };
    this.log.push(entry);
    this.onAdd?.(entry);
    return entry;
  }

  entries(): BlackboardEntry[] {
    return [...this.log];
  }

  /** A compact rendering for injection into an agent's system prompt. */
  render(): string {
    if (this.log.length === 0) return '';
    const lines = this.log.map((e) => `- [${e.kind}] ${e.agent}: ${e.text}`);
    return `## Shared blackboard (crew decisions and findings so far)\n\n${lines.join('\n')}`;
  }
}
