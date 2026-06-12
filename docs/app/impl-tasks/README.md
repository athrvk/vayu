# Implementation Task Files

Each `.md` file in this directory is a **self-contained implementation prompt**
for a subagent working on the "Pure" layout redesign
(see `docs/app/redesign-layout.md` for the full design spec).

## Execution order

Tasks within a stage can run in parallel. Stages must execute in order.

```
Stage 1 — Autosave Hardening (prerequisite, shippable independently)
  1a  task-01a-autosave-flush-on-unmount.md
  1b  task-01b-save-store-flush-all.md
  1c  task-01c-electron-before-quit-flush.md   (depends on 1b)

Stage 2 — Store Cleanup (zero-risk refactor, run after Stage 1)
  2a  task-02a-delete-dead-store-state.md
  2b  task-02b-session-store.md
  2c  task-02c-engine-store-merge.md
  2d  task-02d-collocate-module-stores.md       (run after 2a, 2b, 2c)
  2e  task-02e-import-modal-barrel-and-persist-prefix.md

Stage 3 — Tab Store Infrastructure (can start after Stage 2)
  3a  task-03a-tabs-store.md
  3b  task-03b-tab-strip-component.md           (depends on 3a)

Stage 4 — Layout Store (can run in parallel with Stage 3)
  4a  task-04a-layout-store.md

Stage 5 — Drawer + Dock (depends on 3a, 4a)
  5a  task-05a-drawer-component.md
  5b  task-05b-dock-component.md

Stage 6 — Shell Rewire (depends on 3a, 4a, 5a, 5b)
  6a  task-06a-shell-tab-rendering.md
  6b  task-06b-dissolve-navigation-store.md     (depends on 6a)

Stage 7 — Title Bar (depends on 3b, 6a)
  7a  task-07a-fix-electron-titlebar.md
  7b  task-07b-rewrite-titlebar.md              (depends on 7a, 3b)

Stage 8 — Context Bar (depends on 4a, 3a, 6a)
  8a  task-08a-context-bar.md

Stage 9 — Divider + Split (depends on 4a)
  9a  task-09a-divider-grip-and-split-ratio.md

Stage 10 — Docs (do last, after all code tasks)
  10a task-10a-docs-state-management.md
  10b task-10b-docs-architecture.md
  10c task-10c-docs-components.md
  10d task-10d-docs-file-conventions.md
```

## Each file contains

- **Context**: what exists today, why this task matters
- **Exact files** to read and modify
- **What to create/change**: pseudocode, type signatures, patterns to follow
- **Acceptance criteria**: how to verify the task is done (`pnpm type-check`,
  `pnpm lint`, specific behaviours)

## Notes for agents

- Branch: `claude/clever-sagan-b4oTu`
- Always run `pnpm type-check` and `pnpm lint` before committing
- Commit with clear messages referencing the task number
- The design spec is at `docs/app/redesign-layout.md`
- Do not skip reading the actual files before editing — the context in
  each task is accurate as of the task-writing date but the agent must
  verify before making changes
