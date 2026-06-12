# Task 2e — Fix import-modal-store barrel export and persist key prefix

## Context

Repository: `athrvk/vayu`. Work on branch `claude/clever-sagan-b4oTu`.

Two small housekeeping items:

1. `app/src/stores/import-modal-store.ts` is **not exported** from the barrel
   `app/src/stores/index.ts`. It is currently imported by direct path from
   components. Adding it to the barrel is consistent with all other stores.

2. The `variables-store` (or its post-2d moved location) persists under the
   key `"variables-ui-store"` — no namespace prefix. The convention going
   forward is `"vayu.<name>"` (matches what `session-store.ts` uses from
   task 2b). Migrate the key with a `migrate` function so existing users
   don't lose their active environment selection.

## Step 1 — Add import-modal-store to barrel

**File**: `app/src/stores/index.ts`

Add:
```ts
export { useImportModalStore } from "./import-modal-store";
```

Then update any component that imports `useImportModalStore` via a direct
relative path to use `@/stores` instead (run a grep to find them).

## Step 2 — Migrate persist key in variables-store

**File**: `app/src/modules/variables/variables-store.ts`
(or `app/src/stores/variables-store.ts` if task 2d hasn't landed yet)

Change the `persist` options:

```ts
{
  name: "vayu.variables",
  version: 1,
  migrate: (persisted: unknown, version: number) => {
    // v0 had no version field — accept as-is (fields are compatible)
    if (version === 0) return persisted;
    return persisted;
  },
  partialize: (state) => ({
    selectedCategory: state.selectedCategory,
    // activeEnvironmentId and activeCollectionId were removed in task 2b
  }),
}
```

The `migrate` function here is a no-op (the persisted shape is compatible)
but the version bump will clear the old `"variables-ui-store"` key from
localStorage on first load, which is acceptable.

## Acceptance criteria

- `pnpm type-check` passes.
- `pnpm lint` passes.
- `useImportModalStore` appears in `app/src/stores/index.ts` exports.
- The `variables-store` persist key is `"vayu.variables"`.

## Files to touch

- `app/src/stores/index.ts`
- `app/src/modules/variables/variables-store.ts` (or `stores/variables-store.ts`)
- Any component that imported `useImportModalStore` via direct path (update
  to use `@/stores`)
