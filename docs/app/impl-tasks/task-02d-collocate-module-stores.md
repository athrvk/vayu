# Task 2d — Co-locate module stores into their feature directories

## Context

Repository: `athrvk/vayu`. Work on branch `claude/clever-sagan-b4oTu`.

The codebase organizes feature code under `app/src/modules/<feature>/`. Four
stores are cross-cutting shell state but currently live in the top-level
`app/src/stores/` directory. Per the store architecture refactor plan, stores
that are purely local to a single module should live next to their module.

Stores to move (confirmed module-local — no consumers outside their module):

| Current path | New path |
|---|---|
| `app/src/stores/collections-store.ts` | `app/src/modules/collections/collections-store.ts` |
| `app/src/stores/history-store.ts` | `app/src/modules/history/history-store.ts` |
| `app/src/stores/variables-store.ts` | `app/src/modules/variables/variables-store.ts` |
| `app/src/stores/settings-store.ts` | `app/src/modules/settings/settings-store.ts` |

The file _names_ do not change (only the directory), which keeps the
`kebab-case-store.ts` convention from `docs/app/file-name-conventions.md`.

## Steps

### 1. Verify no cross-module consumers before moving

For each store, run:
```bash
grep -rn "useCollectionsStore" app/src --include="*.ts" --include="*.tsx"
grep -rn "useHistoryStore" app/src --include="*.ts" --include="*.tsx"
grep -rn "useVariablesStore" app/src --include="*.ts" --include="*.tsx"
grep -rn "useSettingsStore" app/src --include="*.ts" --include="*.tsx"
```

If any consumer is outside the corresponding module, note it — do not move
that store and flag it in your commit message.

### 2. Move the files

```bash
mv app/src/stores/collections-store.ts app/src/modules/collections/collections-store.ts
mv app/src/stores/history-store.ts     app/src/modules/history/history-store.ts
mv app/src/stores/variables-store.ts   app/src/modules/variables/variables-store.ts
mv app/src/stores/settings-store.ts    app/src/modules/settings/settings-store.ts
```

### 3. Update all import paths

For each moved file, find all `import ... from '@/stores/collections-store'`
(or relative paths) and update to point to the new module location:

- `@/stores/collections-store` → `@/modules/collections/collections-store`
- `@/stores/history-store` → `@/modules/history/history-store`
- `@/stores/variables-store` → `@/modules/variables/variables-store`
- `@/stores/settings-store` → `@/modules/settings/settings-store`

### 4. Update the barrel `app/src/stores/index.ts`

Remove the four moved stores from the barrel. If any code imports them via
the barrel (`from '@/stores'`), update those imports to point to the module
directly.

### 5. Verify

```bash
pnpm --filter app type-check
```

## Acceptance criteria

- `pnpm type-check` passes.
- `pnpm lint` passes.
- The four old files no longer exist in `app/src/stores/`.
- The four new files exist in their module directories.
- No broken imports remain.

## Files to touch

- The four store files (moved, not modified)
- `app/src/stores/index.ts`
- Any file that imports from the old paths
