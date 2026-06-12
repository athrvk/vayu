# Task 10a — Rewrite `docs/app/state-management.md`

## Context

Repository: `athrvk/vayu`. Work on branch `claude/clever-sagan-b4oTu`.

**Do this task after all store tasks (2a–2e, 3a, 4a) are complete**, since the
doc should reflect the post-refactor layout.

The current `docs/app/state-management.md` is stale in multiple ways:
- References a nonexistent `app-store.ts`
- Describes `response-store` as "viewer UI state" when it actually stores
  responses per requestId (it is a `Map<string, StoredResponse>`)
- Says the metrics cap is 10,000 — the real value in `dashboard-store.ts` is 3,000
- Documents a fictional `useSaveManager` API with `debounceMs` param
- Omits `settings-store` and `import-modal-store`
- Does not reflect the new stores: `tabs-store`, `layout-store`,
  `session-store`, `engine-store`
- Does not reflect module co-location of `collections-store`,
  `history-store`, `variables-store`, `settings-store`

## What to do

Read `docs/app/state-management.md` in full (it is 380 lines). Then read the
actual store files to verify current state:

**Cross-cutting stores** (in `app/src/stores/`):
- `tabs-store.ts` — `openTabs`, `activeTabId`, tab CRUD
- `layout-store.ts` — drawer, context bar, split ratios
- `session-store.ts` — `activeEnvironmentId`, `activeCollectionId`
- `engine-store.ts` — connection + restart state
- `save-store.ts` — save status + context registry + `triggerSave` + `flushAll`
- `response-store.ts` — `Map<requestId, StoredResponse>`
- `live-run-store.ts` (was `dashboard-store.ts`) — metrics buffer, `HISTORICAL_METRICS_CAP = 3000`
- `import-modal-store.ts` — `isOpen`, `open`, `close`

**Module-local stores** (in `app/src/modules/<feature>/`):
- `modules/collections/collections-store.ts` — `expandedCollectionIds`
- `modules/history/history-store.ts` — filters + `filterRuns()` helper
- `modules/variables/variables-store.ts` — `selectedCategory`
- `modules/settings/settings-store.ts` — `selectedCategory`

Rewrite the doc to accurately reflect this layout. The existing doc structure
(Zustand Stores section, TanStack Query section, Custom Hooks section, Best
Practices) is good — keep the structure, update the content.

Key facts to include:
- `HISTORICAL_METRICS_CAP = 3000` (not 10,000)
- `useSaveManager` options: `entityId`, `contextName`, `onSave`, `hasChanges`,
  `enabled` — no `debounceMs`
- `response-store` is keyed by `requestId`, stores responses per entity
- All persisted stores use key prefix `vayu.` and `version: 1`
- Module stores co-locate with their module (convention change from docs)

## Acceptance criteria

- The doc accurately describes all current stores (no ghost stores, no missing stores).
- The `useSaveManager` API section matches the actual hook signature.
- The metrics cap is documented as 3,000.
- Module co-location is explained.
- Markdown renders correctly (no broken headers, tables, or code blocks).

## Files to touch

- `docs/app/state-management.md` (rewrite)
