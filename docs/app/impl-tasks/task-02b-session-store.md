# Task 2b — Extract shared session state to `session-store.ts`

## Context

Repository: `athrvk/vayu`. Work on branch `claude/clever-sagan-b4oTu`.

`app/src/stores/variables-store.ts` currently persists `activeEnvironmentId`
and `activeCollectionId`. These two values are not variables-panel-specific —
they are consumed by the env pill in the title bar and by request execution
(`useVariableResolver`). Moving them to a dedicated `session-store.ts` makes
the dependency explicit and allows the variables panel to be a lightweight
module store in a later task.

## What to create

**New file**: `app/src/stores/session-store.ts`

```ts
import { create } from "zustand";
import { persist } from "zustand/middleware";

interface SessionState {
  activeEnvironmentId: string | null;
  activeCollectionId: string | null;

  setActiveEnvironmentId: (id: string | null) => void;
  setActiveCollectionId: (id: string | null) => void;
}

export const useSessionStore = create<SessionState>()(
  persist(
    (set) => ({
      activeEnvironmentId: null,
      activeCollectionId: null,
      setActiveEnvironmentId: (id) => set({ activeEnvironmentId: id }),
      setActiveCollectionId: (id) => set({ activeCollectionId: id }),
    }),
    {
      name: "vayu.session",
      version: 1,
      partialize: (state) => ({
        activeEnvironmentId: state.activeEnvironmentId,
        activeCollectionId: state.activeCollectionId,
      }),
    }
  )
);
```

## What to update

### `app/src/stores/variables-store.ts`

1. Remove `activeEnvironmentId`, `activeCollectionId`, `setActiveEnvironmentId`,
   `setActiveCollection`, and their aliases from the interface and implementation.
2. Remove them from the `persist` partialize and from `reset()`.
3. Keep `selectedCategory` / `setSelectedCategory` (variables-panel specific).
4. The persist key can stay `"variables-ui-store"` for now (or rename to
   `"vayu.variables"` to match the new prefix — either is fine, just be
   consistent).

### All call sites of `useVariablesStore` that read/write `activeEnvironmentId`
or `activeCollectionId`

Run: `grep -rn "activeEnvironmentId\|activeCollectionId\|setActiveEnvironmentId\|setActiveCollection\b" app/src --include="*.ts" --include="*.tsx"`

For each hit, switch the import from `useVariablesStore` to `useSessionStore`
and update the destructured field names if needed.

### `app/src/stores/index.ts`

Add the export:
```ts
export { useSessionStore } from "./session-store";
```

## Acceptance criteria

- `pnpm type-check` passes.
- `pnpm lint` passes.
- No remaining references to `activeEnvironmentId` / `activeCollectionId`
  inside `variables-store.ts`.
- `useSessionStore` is exported from the barrel.

## Files to touch

- `app/src/stores/session-store.ts` (new)
- `app/src/stores/variables-store.ts`
- `app/src/stores/index.ts`
- Any component files that consumed `activeEnvironmentId`/`activeCollectionId`
  from `useVariablesStore`
