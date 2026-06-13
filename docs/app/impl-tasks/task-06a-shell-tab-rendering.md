# Task 6a — Rewrite `Shell.tsx` for tab-driven rendering

## Context

Repository: `athrvk/vayu`. Work on branch `claude/clever-sagan-b4oTu`.

**Prerequisites**: Tasks 3a (tabs-store), 4a (layout-store), 5a (Drawer), 5b (Dock)
must be complete before this task.

`app/src/components/layout/Shell.tsx` currently uses `resolveActiveScreen()`
from `navigation-store` to decide which screen to render. The redesign replaces
this with tab-driven rendering: the active tab's `type` and `entityId`
determine what the main content area shows.

The new shell layout:

```
<TitleBar> (with TabStrip — wired in task 7b)
<div class="flex flex-1 overflow-hidden">
  <Drawer />                    (task 5a)
  <main class="flex-1 ...">    (content keyed on active tab)
    {renderTabContent()}
  </main>
  <ContextBar />                (task 8a — stub if not done yet)
</div>
<Dock />                        (task 5b)
```

## What to change

**File**: `app/src/components/layout/Shell.tsx`

### 1. Replace the screen resolution logic

Remove the import and usage of `useNavigationStore` / `resolveActiveScreen`.
Instead:

```tsx
const { openTabs, activeTabId } = useTabsStore();
const activeTab = openTabs.find((t) => t.id === activeTabId) ?? null;
```

### 2. Replace `renderMainContent()` with `renderTabContent()`

Map each `TabType` to the existing module component:

```tsx
function renderTabContent(tab: Tab | null): React.ReactNode {
  if (!tab) {
    // Zero-tab state — show welcome
    return <WelcomeScreen />;
  }
  switch (tab.type) {
    case "welcome":
      return <WelcomeScreen />;
    case "request":
      return tab.entityId
        ? <RequestBuilderLayout requestId={tab.entityId} />
        : <WelcomeScreen />;
    case "collection":
      return tab.entityId
        ? <CollectionDetail collectionId={tab.entityId} />
        : null;
    case "dashboard":
      return <LoadTestDashboard />;
    case "run":
      return tab.entityId
        ? <HistoryDetail runId={tab.entityId} />
        : null;
    case "variables":
      return <VariablesMain />;
    case "settings":
      return <SettingsMain />;
    default:
      return null;
  }
}
```

Check the existing `Shell.tsx` for the exact import paths of each module
component. Do not change the module components themselves.

### 3. Update the JSX

Replace the existing sidebar + content JSX with the new structure:

```tsx
return (
  <div className="flex flex-col h-screen overflow-hidden bg-background">
    <TitleBar />
    <div className="flex flex-1 overflow-hidden">
      <Drawer />
      <main className="flex-1 overflow-hidden flex flex-col">
        {renderTabContent(activeTab)}
      </main>
      {/* ContextBar here when task 8a is done */}
    </div>
    <Dock />
  </div>
);
```

### 4. Move the `⌘S` keyboard handler

The existing `⌘S` → `triggerSave()` handler in `Shell.tsx` should stay here
(it's shell-level). Keep it, just ensure it still works with the new structure.

### 5. Add `⌘W` → close active tab

```tsx
case "w":
  if (e.metaKey || e.ctrlKey) {
    if (activeTabId) closeTab(activeTabId);
    e.preventDefault();
  }
  break;
```

### 6. Add `⌘B` → toggle drawer

```tsx
case "b":
  if (e.metaKey || e.ctrlKey) {
    toggleDrawer();
    e.preventDefault();
  }
  break;
```

### 7. Add `⌘1`–`⌘9` → jump to tab N

```tsx
if ((e.metaKey || e.ctrlKey) && e.key >= "1" && e.key <= "9") {
  const idx = parseInt(e.key) - 1;
  const tab = openTabs[idx];
  if (tab) focusTab(tab.id);
  e.preventDefault();
}
```

## Acceptance criteria

- `pnpm type-check` passes.
- `pnpm lint` passes.
- Zero-tab state shows `WelcomeScreen`.
- Switching tabs renders the correct content.
- Old `resolveActiveScreen` import is gone.
- `⌘S`, `⌘W`, `⌘B`, `⌘1`–`⌘9` keyboard handlers are present.

## Files to touch

- `app/src/components/layout/Shell.tsx` (rewrite core logic; keep imports
  that still apply)
