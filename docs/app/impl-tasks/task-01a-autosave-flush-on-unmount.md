# Task 1a — Autosave: flush pending save on unmount/entity-switch

## Context

Repository: `athrvk/vayu`. Work on branch `claude/clever-sagan-b4oTu`.

The file `app/src/hooks/useSaveManager.ts` has a data-loss bug: when the hook
unmounts (user switches to a different request tab) it calls `clearTimeout`
on the debounce timer but **does not flush the pending save**. Any edit made
fewer than 3 seconds before switching is silently discarded.

The hook already has a `performSave` function and a `hasChanges`/`enabled`
prop. The fix is small.

## What to change

**File**: `app/src/hooks/useSaveManager.ts`

Locate the cleanup `useEffect` that currently reads:

```ts
// Clear timeouts on unmount
useEffect(() => {
  return () => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }
    if (savedTimeoutRef.current) {
      clearTimeout(savedTimeoutRef.current);
    }
  };
}, []);
```

Replace with a flush-on-unmount pattern. The cleanup function needs access to
`hasChanges`, `enabled`, `entityId`, and `performSave`. Because the cleanup
runs with stale closure values, use refs:

1. Add two refs near the top of the hook (after existing refs):
   ```ts
   const hasChangesRef = useRef(hasChanges);
   const enabledRef = useRef(enabled);
   ```

2. Keep them updated alongside the existing `onSaveRef`:
   ```ts
   useEffect(() => { hasChangesRef.current = hasChanges; }, [hasChanges]);
   useEffect(() => { enabledRef.current = enabled; }, [enabled]);
   ```

3. Replace the bare cleanup effect with one that flushes when there are
   pending changes:
   ```ts
   useEffect(() => {
     return () => {
       if (timeoutRef.current) {
         clearTimeout(timeoutRef.current);
         timeoutRef.current = null;
       }
       if (savedTimeoutRef.current) {
         clearTimeout(savedTimeoutRef.current);
       }
       // Flush any pending save so edits aren't lost on unmount / entity switch
       if (enabledRef.current && hasChangesRef.current) {
         performSave();
       }
     };
     // performSave is stable (useCallback with stable deps); safe in cleanup
     // eslint-disable-next-line react-hooks/exhaustive-deps
   }, []);
   ```

   Note: `performSave` is already a `useCallback` whose identity is stable
   across renders (its deps are store actions which never change). The lint
   disable is intentional — the cleanup should only register once.

4. Also fix the **entity-switch reset effect** (the one that calls
   `reset()` and clears the timeout on `entityId` change). Before clearing
   the timeout it should flush if there are pending changes **for the
   previous entity**. Add before `clearTimeout`:
   ```ts
   if (hasChangesRef.current && enabledRef.current) {
     performSave();
   }
   ```

## Acceptance criteria

- `pnpm type-check` passes in `app/`.
- No new ESLint errors (`pnpm lint`).
- The hook correctly calls `performSave()` when it unmounts with
  `hasChanges === true` and `enabled === true`.
- The hook does NOT call `performSave()` when `hasChanges === false`.

## Files to touch

- `app/src/hooks/useSaveManager.ts` only.
