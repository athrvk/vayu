# Task 10d — Update `docs/app/file-name-conventions.md`

## Context

Repository: `athrvk/vayu`. Work on branch `claude/clever-sagan-b4oTu`.

`docs/app/file-name-conventions.md` is the authoritative naming guide. One
addition is needed: the Directory Structure section shows the `modules/`
layout but the current template does not show co-located module stores.

## What to change

**File**: `docs/app/file-name-conventions.md`

Find the `## Directory Structure` section with the template:

```
modules/
├── [module-name]/
│   ├── sidebar/
│   ├── main/
│   ├── components/
│   ├── types.ts
│   └── index.ts
```

Add the co-located store entry:

```
modules/
├── [module-name]/
│   ├── sidebar/           # Sidebar components (PascalCase.tsx)
│   ├── main/              # Main content components (PascalCase.tsx)
│   ├── components/        # Sub-components (PascalCase.tsx)
│   ├── [module]-store.ts  # Module-local UI store (kebab-case-store.ts)
│   ├── types.ts           # Type definitions
│   └── index.ts           # Barrel exports
```

Also add a note in the Stores section explaining when a store co-locates
vs. stays in `stores/`:

> **Co-location rule**: If a store's state is only consumed within a single
> module (e.g., `expandedCollectionIds` in `collections-store`), place the
> store file in `modules/<module>/`. If it is consumed by multiple modules
> or by shell-level components, keep it in `stores/`. The file name
> convention (`kebab-case-store.ts`) applies regardless of location.

Update the Summary Table to add a row:

| Module Stores | `kebab-case-store.ts` | `collections-store.ts` |

## Acceptance criteria

- The directory template shows `[module]-store.ts`.
- The co-location rule is documented.
- The summary table has the new row.
- Markdown renders correctly.
- The document remains authoritative (no contradictions introduced).

## Files to touch

- `docs/app/file-name-conventions.md`
