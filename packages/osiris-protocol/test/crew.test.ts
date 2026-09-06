import { describe, expect, it } from 'vitest';
import {
  AgentDefinition,
  CrewConfig,
  DEFAULT_TASK_MODELS,
  TASK_CLASSES,
  TASK_CLASS_LABELS,
} from '../src/crew.js';

describe('task-class contract', () => {
  it('every class has a label and a default model spec', () => {
    for (const cls of TASK_CLASSES) {
      expect(TASK_CLASS_LABELS[cls]).toBeTruthy();
      expect(DEFAULT_TASK_MODELS[cls]).toMatch(/^[\w-]+\/[\w.:-]+$/);
    }
    expect(Object.keys(DEFAULT_TASK_MODELS).sort()).toEqual([...TASK_CLASSES].sort());
  });

  it('AgentDefinition accepts an optional taskClass and rejects unknown ones', () => {
    expect(AgentDefinition.parse({ name: 'a', role: 'r', taskClass: 'planning' }).taskClass).toBe(
      'planning',
    );
    expect(AgentDefinition.safeParse({ name: 'a', role: 'r', taskClass: 'nope' }).success).toBe(
      false,
    );
    expect(AgentDefinition.parse({ name: 'a', role: 'r' }).taskClass).toBeUndefined();
  });

  it('CrewConfig.taskModels defaults to an empty map', () => {
    expect(CrewConfig.parse({ lead: 'architect' }).taskModels).toEqual({});
    expect(
      CrewConfig.parse({ lead: 'architect', taskModels: { planning: 'anthropic/claude-opus-5' } })
        .taskModels.planning,
    ).toBe('anthropic/claude-opus-5');
  });
});
