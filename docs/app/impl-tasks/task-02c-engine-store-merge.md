# Task 2c — Merge engine stores into `engine-store.ts`

## Context

Repository: `athrvk/vayu`. Work on branch `claude/clever-sagan-b4oTu`.

Engine-related state is split across two files:
- `app/src/stores/engine/engine-connection-store.ts` — `isEngineConnected`, `engineError`
- `app/src/stores/settings-store.ts` — `pendingRestart`, `restartRequiredKeys`

These naturally belong together (both describe engine health/state). The plan
merges them into `app/src/stores/engine-store.ts` and removes the
`settings-store.ts` restart state.

## What to create

**New file**: `app/src/stores/engine-store.ts`

Merge both stores into one:

```ts
import { create } from "zustand";

interface EngineState {
  // Connection
  isEngineConnected: boolean;
  engineError: string | null;

  // Restart
  pendingRestart: boolean;
  restartRequiredKeys: string[];

  // Actions
  setEngineConnected: (connected: boolean) => void;
  setEngineError: (error: string | null) => void;
  setPendingRestart: (pending: boolean, keys?: string[]) => void;
  addRestartRequiredKey: (key: string) => void;
  clearRestartRequired: () => void;
  reset: () => void;
}

export const useEngineStore = create<EngineState>((set) => ({
  isEngineConnected: false,
  engineError: null,
  pendingRestart: false,
  restartRequiredKeys: [],

  setEngineConnected: (connected) => set({ isEngineConnected: connected }),
  setEngineError: (error) => set({ engineError: error }),
  setPendingRestart: (pending, keys) =>
    set((s) => ({
      pendingRestart: pending,
      restartRequiredKeys: keys ?? s.restartRequiredKeys,
    })),
  addRestartRequiredKey: (key) =>
    set((s) => ({
      restartRequiredKeys: s.restartRequiredKeys.includes(key)
        ? s.restartRequiredKeys
        : [...s.restartRequiredKeys, key],
    })),
  clearRestartRequired: () => set({ pendingRestart: false, restartRequiredKeys: [] }),
  reset: () =>
    set({ isEngineConnected: false, engineError: null, pendingRestart: false, restartRequiredKeys: [] }),
}));
```

## What to update

### `app/src/stores/settings-store.ts`

Remove `pendingRestart`, `restartRequiredKeys`, `setPendingRestart`,
`addRestartRequiredKey`, `clearRestartRequired` from both the interface and
the implementation.

### `app/src/stores/index.ts`

Replace:
```ts
export { useEngineConnectionStore } from "./engine";
```
with:
```ts
export { useEngineStore } from "./engine-store";
```

Keep the old `engine/` directory export only if something else imports from
it; otherwise remove it.

### All call sites

Run these greps and update imports:
```
grep -rn "useEngineConnectionStore" app/src --include="*.ts" --include="*.tsx"
grep -rn "useSettingsStore" app/src --include="*.ts" --include="*.tsx"
```

For `useEngineConnectionStore` consumers: switch to `useEngineStore`.
For `useSettingsStore` consumers that used `pendingRestart`/`restartRequiredKeys`:
switch those fields to `useEngineStore`.

### `app/src/stores/engine/engine-connection-store.ts`

Delete this file (or leave as a re-export shim if TypeScript migration is
safer — but prefer deletion).

## Acceptance criteria

- `pnpm type-check` passes.
- `pnpm lint` passes.
- No references to `useEngineConnectionStore` remain.
- `useEngineStore` is exported from the barrel.

## Files to touch

- `app/src/stores/engine-store.ts` (new)
- `app/src/stores/engine/engine-connection-store.ts` (delete or shim)
- `app/src/stores/settings-store.ts` (remove restart fields)
- `app/src/stores/index.ts`
- All consumers of `useEngineConnectionStore` and `useSettingsStore` restart fields
