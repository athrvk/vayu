# Task 10b — Update `docs/app/architecture.md`

## Context

Repository: `athrvk/vayu`. Work on branch `claude/clever-sagan-b4oTu`.

**Do this task after the shell redesign tasks (6a, 6b) are complete**.

`docs/app/architecture.md` has several stale sections:

1. **Directory tree** — predates the `modules/` reorganization. The tree
   shows `components/request-builder/`, `components/load-test-dashboard/`,
   etc., but the actual code lives in `modules/request-builder/`,
   `modules/dashboard/`, etc.

2. **Ghost store** — references `app-store.ts` which does not exist.
   The real stores are `navigation-store.ts` (now dissolved into
   `tabs-store.ts` + `layout-store.ts`), `engine-connection-store.ts`
   (now `engine-store.ts`), etc.

3. **Preload described as "currently unused"** — incorrect. The preload
   at `app/electron/preload.js` carries window controls IPC (minimize,
   maximize, close), theme sync, and `restartEngine` IPC.

4. **Metrics cap** — claims 10,000 historical metrics; real value is 3,000.

## What to do

Read `docs/app/architecture.md` in full. Then read the actual directory
structure to verify:

```bash
ls app/src/
ls app/src/modules/
ls app/src/components/
ls app/src/stores/
cat app/electron/preload.js
```

Update the following sections:

### Application Structure section

Replace the directory tree under `#### Application Structure` with the actual
`modules/`-based layout. Key directories to reflect:
- `modules/` — feature modules (request-builder, dashboard, history,
  collections, variables, settings, welcome)
- `components/layout/` — Shell, TitleBar, TabStrip, Drawer, Dock, ContextBar
- `components/ui/` — shared Radix UI primitives
- `stores/` — cross-cutting stores (tabs-store, layout-store, session-store,
  engine-store, save-store, response-store, live-run-store, import-modal-store)

### State Management section

Update the store list to match the post-refactor layout (see task 10a for the
complete list). Remove references to `app-store.ts`.

### Services Layer / Electron section

Update the preload description to accurately reflect what it exposes:
window controls IPC (minimize, maximize, close), theme change events,
`restartEngine` IPC call.

### Performance Optimizations section

Change "Metrics Limiting: Dashboard store limits historical metrics to 10,000 points"
to 3,000.

## Acceptance criteria

- No references to `app-store.ts` remain.
- Preload is accurately described.
- Directory tree matches the actual `modules/` layout.
- Metrics cap is 3,000.
- Markdown renders correctly.

## Files to touch

- `docs/app/architecture.md`
