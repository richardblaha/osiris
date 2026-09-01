import type { StepModel } from './parser/stepParser.js';

export interface StepStats {
  entityCount: number;
  distinctTypes: number;
  topTypes: { type: string; count: number }[];
  schemaIdentifiers: string[];
}

/** Aggregate entity-type counts for the `osiris-step.stats` command. */
export function computeStats(model: StepModel, topN = 15): StepStats {
  const counts = new Map<string, number>();
  for (const entity of model.entities.values()) {
    counts.set(entity.type, (counts.get(entity.type) ?? 0) + 1);
  }
  const topTypes = [...counts.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type))
    .slice(0, topN);

  return {
    entityCount: model.entities.size,
    distinctTypes: counts.size,
    topTypes,
    schemaIdentifiers: model.schemaIdentifiers,
  };
}
