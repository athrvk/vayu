# Task 1b — Save store: add `runSave()` helper and `flushAll()`

## Context

Repository: `athrvk/vayu`. Work on branch `claude/clever-sagan-b4oTu`.

`app/src/stores/save-store.ts` currently duplicates the
`startSaving → completeSave → setTimeout(idle)` sequence in `triggerSave`.
The same sequence is written identically in `useSaveManager.ts`'s
`performSave` and in `SettingsMain.handleSave`. A single internal `runSave()`
helper in the store will own it, and a new `flushAll()` action will drain all
contexts with pending changes (needed for Electron before-quit and LRU
tab-close, implemented in later tasks).

## What to change

**File**: `app/src/stores/save-store.ts`

### 1. Add `flushAll` to the interface

In the `SaveState` interface, add after `triggerSave`:

```ts
/** Flush every registered context that has pending changes. Used before quit / on tab close. */
flushAll: () => Promise<void>;
```

### 2. Extract `runSave()` helper inside `create`

After the existing `getActiveContext` definition and before `triggerSave`,
add an internal helper. Because Zustand's `create` callback is a plain
function, you can declare a local async function:

```ts
// Internal helper — runs a save for the given context and updates store state.
// Caller must own the in-progress guard if needed.
const runSave = async (context: SaveContext) => {
  set({ status: "saving", errorMessage: null });
  try {
    await context.save();
    set({ status: "saved", lastSavedAt: Date.now(), pendingSaveId: null, errorMessage: null });
    setTimeout(() => {
      // Only reset to idle if we're still in the "saved" state
      if (get().status === "saved") get().setStatus("idle");
    }, 2000);
  } catch (error) {
    set({
      status: "error",
      errorMessage: error instanceof Error ? error.message : "Save failed",
      pendingSaveId: null,
    });
  }
};
```

### 3. Simplify `triggerSave` to use `runSave()`

Replace the body of `triggerSave` with:

```ts
triggerSave: async () => {
  const activeContext = get().getActiveContext();
  if (activeContext) {
    await runSave(activeContext);
    return;
  }
  // Fallback: save any context with pending changes
  for (const context of get().contexts.values()) {
    if (context.hasPendingChanges) {
      await runSave(context);
      return;
    }
  }
},
```

### 4. Add `flushAll` implementation

```ts
flushAll: async () => {
  const saves = [...get().contexts.values()]
    .filter((c) => c.hasPendingChanges)
    .map((c) => runSave(c));
  await Promise.all(saves);
},
```

## Acceptance criteria

- `pnpm type-check` passes in `app/`.
- `useSaveStore().flushAll` exists and is callable.
- `useSaveStore().triggerSave` behaviour is unchanged (saves active or first
  pending context).
- No new ESLint errors (`pnpm lint`).

## Files to touch

- `app/src/stores/save-store.ts` only.
