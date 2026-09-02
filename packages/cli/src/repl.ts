import { start } from 'node:repl';
import type { WorkspaceServices } from './workspace.js';

/**
 * An interactive REPL with the workspace services in scope:
 *   > await backlog()            → the BacklogRepo
 *   > await agents()             → the crew roster
 *   > await search('orphan', 5)  → knowledge-base hits
 *   > await crew('summarise the repo')
 */
export async function startRepl(services: WorkspaceServices): Promise<void> {
  process.stdout.write(`osiris repl — workspace ${services.root}\n`);
  const repl = start({ prompt: 'osiris> ' });
  Object.assign(repl.context, {
    services,
    paths: services.paths,
    backlog: () => services.openBacklog(),
    agents: () => services.listAgents(),
    reindex: () => services.reindexMemory(),
    search: (q: string, k = 6) => services.searchMemory(q, k),
    crew: (task: string, lead?: string) => services.runCrew(task, lead, () => {}),
  });
  await new Promise<void>((resolve) => repl.on('exit', resolve));
}
