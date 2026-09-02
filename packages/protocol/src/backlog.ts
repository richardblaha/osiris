/**
 * File-based, Git-managed backlog. Tasks are Markdown files named
 * `[<type>]-<id>-<slug>.md`; the workflow state is the sub-folder they live in.
 * The whole backlog is kept on an orphan branch (`osiris/backlog`).
 */
import { z } from 'zod';

export const TaskType = z.string().regex(/^[a-z][a-z0-9]*$/, 'lowercase, e.g. bug / feat / chore');
export type TaskType = z.infer<typeof TaskType>;

export const TaskFrontmatter = z
  .object({
    id: z.number().int().nonnegative(),
    type: TaskType,
    title: z.string().min(1),
    assignee: z.string().optional(),
    labels: z.array(z.string()).default([]),
    created: z.string().optional(),
  })
  .passthrough();
export type TaskFrontmatter = z.infer<typeof TaskFrontmatter>;

export const BacklogTask = z.object({
  id: z.number().int().nonnegative(),
  type: TaskType,
  slug: z.string().min(1),
  title: z.string().min(1),
  state: z.string().min(1),
  /** File name, e.g. `[bug]-0101-parser-crash.md`. */
  filename: z.string().min(1),
  assignee: z.string().optional(),
  labels: z.array(z.string()),
  created: z.string().optional(),
  body: z.string(),
});
export type BacklogTask = z.infer<typeof BacklogTask>;

export const BacklogBoard = z.object({
  branch: z.string(),
  states: z.array(z.string()),
  tasks: z.array(BacklogTask),
});
export type BacklogBoard = z.infer<typeof BacklogBoard>;

export const CreateTaskRequest = z.object({
  type: TaskType,
  title: z.string().min(1),
  state: z.string().min(1).optional(),
  assignee: z.string().optional(),
  labels: z.array(z.string()).optional(),
  body: z.string().optional(),
});
export type CreateTaskRequest = z.infer<typeof CreateTaskRequest>;

export const MoveTaskRequest = z.object({
  toState: z.string().min(1),
});
export type MoveTaskRequest = z.infer<typeof MoveTaskRequest>;
