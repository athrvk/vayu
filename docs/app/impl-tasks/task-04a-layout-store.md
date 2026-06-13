# Task 4a — Create `layout-store.ts`

## Context

Repository: `athrvk/vayu`. Work on branch `claude/clever-sagan-b4oTu`.

The new shell layout has several persisted geometric state values that need a
dedicated store. This store replaces the `sidebarPanelOpen` / `activeSidebarTab`
fields in `navigation-store` and adds new fields for the redesigned drawer,
context bar, and split panel.

## What to create

**New file**: `app/src/stores/layout-store.ts`

```ts
import { create } from "zustand";
import { persist } from "zustand/middleware";

export type DrawerView = "collections" | "history" | "variables";

const DEFAULT_DRAWER_WIDTHS: Record<DrawerView, number> = {
  collections: 260,
  history: 320,   // history carries URL text, needs more width
  variables: 260,
};

interface LayoutState {
  // Drawer
  drawerOpen: boolean;
  drawerView: DrawerView;
  drawerWidths: Record<DrawerView, number>;

  // Context bar (right panel for request tabs)
  contextBarOpen: boolean;

  // Request / response split ratio (0–1, fraction for the left/request pane)
  requestSplitRatio: number;

  // Actions
  setDrawerOpen: (open: boolean) => void;
  toggleDrawer: () => void;
  setDrawerView: (view: DrawerView) => void;
  /** Open the drawer to a specific view, or toggle it closed if already on that view */
  activateDrawerView: (view: DrawerView) => void;
  setDrawerWidth: (view: DrawerView, width: number) => void;

  setContextBarOpen: (open: boolean) => void;
  toggleContextBar: () => void;

  setRequestSplitRatio: (ratio: number) => void;
}

export const useLayoutStore = create<LayoutState>()(
  persist(
    (set, get) => ({
      drawerOpen: true,
      drawerView: "collections",
      drawerWidths: { ...DEFAULT_DRAWER_WIDTHS },
      contextBarOpen: false,
      requestSplitRatio: 0.5,

      setDrawerOpen: (open) => set({ drawerOpen: open }),
      toggleDrawer: () => set((s) => ({ drawerOpen: !s.drawerOpen })),
      setDrawerView: (view) => set({ drawerView: view }),
      activateDrawerView: (view) =>
        set((s) => ({
          drawerView: view,
          drawerOpen: s.drawerView === view ? !s.drawerOpen : true,
        })),
      setDrawerWidth: (view, width) =>
        set((s) => ({
          drawerWidths: {
            ...s.drawerWidths,
            [view]: Math.max(220, Math.min(480, width)),
          },
        })),

      setContextBarOpen: (open) => set({ contextBarOpen: open }),
      toggleContextBar: () => set((s) => ({ contextBarOpen: !s.contextBarOpen })),

      setRequestSplitRatio: (ratio) =>
        set({ requestSplitRatio: Math.max(0.2, Math.min(0.8, ratio)) }),
    }),
    {
      name: "vayu.layout",
      version: 1,
      partialize: (state) => ({
        drawerOpen: state.drawerOpen,
        drawerView: state.drawerView,
        drawerWidths: state.drawerWidths,
        contextBarOpen: state.contextBarOpen,
        requestSplitRatio: state.requestSplitRatio,
      }),
    }
  )
);
```

## Add to barrel

**File**: `app/src/stores/index.ts`

```ts
export { useLayoutStore, type DrawerView } from "./layout-store";
```

## Acceptance criteria

- `pnpm type-check` passes.
- `pnpm lint` passes.
- `activateDrawerView("collections")` when already on `"collections"` toggles
  the drawer closed.
- Drawer widths are clamped to 220–480.
- Split ratio is clamped to 0.2–0.8.

## Files to touch

- `app/src/stores/layout-store.ts` (new)
- `app/src/stores/index.ts`
