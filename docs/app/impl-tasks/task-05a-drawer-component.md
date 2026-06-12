# Task 5a — Create `Drawer` component

## Context

Repository: `athrvk/vayu`. Work on branch `claude/clever-sagan-b4oTu`.

The `Drawer` replaces the existing `Sidebar.tsx` + `ActivityBar`. It is a
resizable left panel with three content views: Collections, History, Variables.
The view is controlled by `useLayoutStore().drawerView` (task 4a).

## What to create

**New file**: `app/src/components/layout/Drawer.tsx`

The component:

1. Reads `drawerOpen`, `drawerView`, `drawerWidths`, `setDrawerWidth` from
   `useLayoutStore`.
2. When `!drawerOpen`, renders nothing (width = 0, content hidden).
3. When open, renders at `drawerWidths[drawerView]` width with a right-edge
   resize handle.
4. The resize handle: 1px visible divider, ~8px invisible hit area, drag
   to resize. On double-click, reset to default width for the current view.
5. Content: renders the appropriate panel component based on `drawerView`:
   - `"collections"` → `<CollectionTree />` (already exists at
     `app/src/modules/collections/CollectionTree.tsx`)
   - `"history"` → `<HistoryList />` (already exists at
     `app/src/modules/history/sidebar/HistoryList.tsx`)
   - `"variables"` → `<VariablesCategoryTree />` (already exists at
     `app/src/modules/variables/sidebar/VariablesCategoryTree.tsx` — check
     exact path)
6. Scroll position is preserved per view (the panel components handle their
   own scroll — do not wrap in a container that resets scroll on view switch).

### Resize implementation

Use a `pointerdown` + `pointermove` approach (not a library):

```tsx
const handleRef = useRef<HTMLDivElement>(null);

const startResize = (e: React.PointerEvent) => {
  e.currentTarget.setPointerCapture(e.pointerId);
  const startX = e.clientX;
  const startWidth = drawerWidths[drawerView];

  const onMove = (moveEvent: PointerEvent) => {
    setDrawerWidth(drawerView, startWidth + moveEvent.clientX - startX);
  };
  const onUp = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
};
```

### Default widths (for double-click reset)

```ts
const DEFAULT_WIDTHS: Record<DrawerView, number> = {
  collections: 260,
  history: 320,
  variables: 260,
};
```

### Skeleton structure

```tsx
export function Drawer() {
  const { drawerOpen, drawerView, drawerWidths, setDrawerWidth } = useLayoutStore();

  if (!drawerOpen) return null;

  const width = drawerWidths[drawerView];

  return (
    <div className="relative flex shrink-0" style={{ width }}>
      {/* Content */}
      <div className="flex-1 overflow-hidden flex flex-col">
        {drawerView === "collections" && <CollectionTree />}
        {drawerView === "history" && <HistoryList />}
        {drawerView === "variables" && <VariablesCategoryTree />}
      </div>

      {/* Resize handle */}
      <div
        className="absolute right-0 top-0 bottom-0 w-2 cursor-col-resize hover:bg-accent/20 group"
        onPointerDown={startResize}
        onDoubleClick={() => setDrawerWidth(drawerView, DEFAULT_WIDTHS[drawerView])}
      >
        <div className="absolute right-0 top-0 bottom-0 w-px bg-border" />
      </div>
    </div>
  );
}
```

## Notes for the agent

- Verify the exact import paths for `CollectionTree`, `HistoryList`, and the
  variables sidebar component by reading the actual files.
- Do not duplicate any props drilling that the panel components already handle
  internally via their own stores/queries.
- Use Tailwind tokens that already exist in the project (`bg-panel`, `bg-border`,
  `text-foreground`, etc.) — check `app/src/index.css` for the actual token names.

## Acceptance criteria

- `pnpm type-check` passes.
- `pnpm lint` passes.
- The component renders all three content views.
- Resize clamps between 220px and 480px (enforced by `setDrawerWidth` in the
  store, task 4a).

## Files to touch

- `app/src/components/layout/Drawer.tsx` (new)
