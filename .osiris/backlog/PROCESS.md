# Backlog process

The backlog is a set of Markdown files under `.osiris/backlog/`. It is managed on
a dedicated **orphan branch** (`osiris/backlog`) so task churn never touches the
history of `main` or `feature/*`. `@osiris/backlog` operates a git worktree under
`.osiris/temp/backlog-worktree/` — you never switch your working branch.

## States

One sub-folder per workflow state, in order:

| Folder         | Meaning                                     |
| -------------- | ------------------------------------------- |
| `todo/`        | Accepted, not started.                      |
| `in-progress/` | Being worked on right now.                  |
| `review/`      | Implementation done, awaiting verification. |
| `done/`        | Verified and closed.                        |

Add or rename folders to change the workflow — the state list is derived from
what is on disk.

## Task files

Filename convention: `[<type>]-<id>-<slug>.md`

- `<type>` — `bug`, `feat`, `chore`, `spike`, `docs` (free-form, lowercase).
- `<id>` — zero-padded integer, unique and monotonic.
- `<slug>` — kebab-case summary.

Example: `[bug]-0101-agent-panel-hangs-on-empty-response.md`

```markdown
---
id: 101
type: bug
title: Agent panel hangs when the model returns an empty response
assignee: implementer
labels: [osiris-ai, agent-panel]
created: 2026-09-02
---

## Context

…

## Acceptance criteria

- [ ] …
```

## Moving a task

`osiris backlog move 101 review` (or drag the card in the console) performs a
`git mv` between state folders and commits it to `osiris/backlog` with a message
like `move: [bug]-0101 todo → review`. Exactly one commit per move.
