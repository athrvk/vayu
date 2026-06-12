# Task 6b — Dissolve `navigation-store` and update all call sites

## Context

Repository: `athrvk/vayu`. Work on branch `claude/clever-sagan-b4oTu`.

**Prerequisite**: Tasks 3a (tabs-store), 4a (layout-store), 6a (Shell rewire) must
be complete.

`navigation-store` (327 lines) was the old router. It is now replaced by
`tabs-store` + `layout-store`. This task removes the store and updates the
13 files that currently import `useNavigationStore`.

## Call sites (confirmed by grep)

```
app/src/modules/history/main/HistoryDetail.tsx
app/src/modules/history/sidebar/HistoryList.tsx
app/src/modules/welcome/WelcomeScreen.tsx
app/src/modules/request-builder/components/ResponseViewer/index.tsx
app/src/modules/request-builder/index.tsx
app/src/modules/dashboard/components/DashboardHeader.tsx
app/src/modules/collections/CollectionDetail/index.tsx
app/src/modules/collections/CollectionTree.tsx
app/src/components/layout/Sidebar.tsx
app/src/components/layout/Shell.tsx  (already updated in task 6a)
app/src/stores/index.ts
app/src/stores/navigation/index.ts
app/src/stores/navigation/navigation-store.ts  (the store itself)
```

## Migration table — old `navigateTo*` → new actions

| Old call | New equivalent |
|---|---|
| `navigateToRequest(collectionId, requestId)` | `openTab({ type: "request", entityId: requestId })` |
| `navigateToCollection(collectionId)` | `openTab({ type: "collection", entityId: collectionId })` |
| `navigateToRunDetail(runId)` | `openTab({ type: "run", entityId: runId })` |
| `navigateToHistory()` | `activateDrawerView("history")` |
| `navigateToVariables()` | `openTab({ type: "variables", entityId: null })` |
| `navigateToSettings()` | `openTab({ type: "settings", entityId: null })` |
| `navigateToWelcome()` | `openTab({ type: "welcome", entityId: null })` |
| `navigateToDashboard()` | `openTab({ type: "dashboard", entityId: null })` |
| `navigateBack()` | `closeTab(activeTabId)` (or implement a tab history — KISS: just close) |
| `canNavigateBack()` | `openTabs.length > 1` |
| `activeSidebarTab` / `setActiveSidebarTab` | `drawerView` / `setDrawerView` from `useLayoutStore` |
| `sidebarPanelOpen` / `setSidebarPanelOpen` | `drawerOpen` / `setDrawerOpen` from `useLayoutStore` |
| `selectedCollectionId` / `selectedRequestId` / `selectedRunId` | derive from `activeTab.entityId` in `useTabsStore` |

## Steps

### 1. Update each call site file

For each file in the list above (except the store files themselves):
1. Remove `import { useNavigationStore } from "@/stores"` or similar.
2. Add imports for `useTabsStore` and/or `useLayoutStore`.
3. Replace each old call with the new equivalent from the table above.

### 2. Delete the navigation store

```bash
rm app/src/stores/navigation/navigation-store.ts
rm app/src/stores/navigation/index.ts
# Remove the navigation/ directory if it's now empty
rmdir app/src/stores/navigation/
```

### 3. Update the barrel

**File**: `app/src/stores/index.ts`

Remove:
```ts
export { useNavigationStore, type NavigationContext } from "./navigation";
```

### 4. Remove `Sidebar.tsx` if it only wraps the old panel

`app/src/components/layout/Sidebar.tsx` used to render the `ActivityBar` +
`SidebarPanel`. If its only job was wrapping the old sidebar, delete it. If it
has other logic, migrate what's needed into `Drawer.tsx` (task 5a) and delete
the rest.

## Acceptance criteria

- `pnpm type-check` passes.
- `pnpm lint` passes.
- No references to `useNavigationStore` remain in `app/src/`.
- The `navigation/` directory is deleted.

## Files to touch

All 13 files listed above, plus `app/src/components/layout/Sidebar.tsx`.
