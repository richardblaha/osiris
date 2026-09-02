import type { ServiceSpec } from './stack.js';

/**
 * Kahn topological sort of services by `dependsOn`. Throws on an unknown
 * dependency or a cycle so the orchestrator fails fast instead of deadlocking.
 */
export function topoSort(services: readonly ServiceSpec[]): ServiceSpec[] {
  const byName = new Map<string, ServiceSpec>(services.map((s): [string, ServiceSpec] => [s.name, s]));
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const svc of services) {
    if (!indegree.has(svc.name)) indegree.set(svc.name, 0);
    for (const dep of svc.dependsOn ?? []) {
      if (!byName.has(dep)) {
        throw new Error(`service "${svc.name}" depends on unknown service "${dep}"`);
      }
      indegree.set(svc.name, (indegree.get(svc.name) ?? 0) + 1);
      dependents.set(dep, [...(dependents.get(dep) ?? []), svc.name]);
    }
  }

  const queue: string[] = services
    .filter((s) => (indegree.get(s.name) ?? 0) === 0)
    .map((s) => s.name);
  const ordered: ServiceSpec[] = [];

  while (queue.length > 0) {
    const name = queue.shift();
    if (name === undefined) break;
    const svc = byName.get(name);
    if (svc) ordered.push(svc);
    for (const next of dependents.get(name) ?? []) {
      const remaining = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, remaining);
      if (remaining === 0) queue.push(next);
    }
  }

  if (ordered.length !== services.length) {
    throw new Error('dependency cycle detected in stack services');
  }
  return ordered;
}
