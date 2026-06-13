# Task 2a — Delete dead state from existing stores

## Context

Repository: `athrvk/vayu`. Work on branch `claude/clever-sagan-b4oTu`.

Three stores carry state and actions that have been grep-verified to have
**zero consumers** across the entire codebase. Deleting them shrinks the
interface and removes misleading API surface before the redesign adds new state.

## Dead fields confirmed (grep verified — zero call sites)

### `app/src/stores/collections-store.ts`
- State: `isSavingCollection: boolean`, `isSavingRequest: boolean`
- Actions: `setSavingCollection`, `setSavingRequest`
- Also remove from `reset()` initializer

### `app/src/stores/history-store.ts`
- State: `isDeletingRun: boolean`
- Action: `setDeletingRun`
- Also remove from `resetFilters()` initializer (if present) and from the
  `HistoryUIState` interface

### `app/src/stores/variables-store.ts`
- State: `isEditing: boolean`
- Action: `setEditing`
- Alias actions (duplicates): `selectCategory` (same as `setSelectedCategory`),
  `setActiveEnvironment` (same as `setActiveEnvironmentId`)
- Also remove from `reset()` initializer
- Remove from the `VariablesUIState` interface

## Steps

1. Open each file, remove the dead fields from the TypeScript interface,
   from the `create(...)` initial state object, and the corresponding action
   implementations.
2. Run `grep -rn "isSavingCollection\|isSavingRequest\|isDeletingRun\|isEditing\|selectCategory\|setActiveEnvironment[^I]" app/src` to confirm zero remaining references before committing.
3. `pnpm type-check` must pass.

## Acceptance criteria

- All three files compile cleanly.
- `pnpm type-check` passes.
- `pnpm lint` passes.
- Grep for the removed identifiers returns no hits in `app/src/`.

## Files to touch

- `app/src/stores/collections-store.ts`
- `app/src/stores/history-store.ts`
- `app/src/stores/variables-store.ts`
