# Task 3b — Create `TabStrip` component

## Context

Repository: `athrvk/vayu`. Work on branch `claude/clever-sagan-b4oTu`.

The `TabStrip` is the horizontal row of open tabs that sits in the title bar.
It reads from `useTabsStore` (task 3a) and renders one tab per entry in
`openTabs`. This task creates the component in isolation; it is wired into
`TitleBar.tsx` in task 7b.

## Design spec

- Tabs shrink to fit the available width but never narrower than the HTTP
  method badge + a legible truncated path.
- Active tab: `bg-background` (same as main content area), no bottom border.
  Inactive tabs: `bg-panel` with a hairline bottom border.
- Label format per tab type:
  - `request`: `METHOD /path` — resolved from `entityId` (request data)
  - `collection`: `📁 Name`
  - `dashboard`: `⚡ METHOD /path · Running` (or `· Done`)
  - `run`: `🕐 METHOD /path`
  - `variables`: `Variables`
  - `settings`: `Settings`
  - `welcome`: `Vayu`
- Close button (×) on hover; keyboard: `⌘W` closes active tab.
- No unsaved dot (autosave is the safety net).
- `+` button at the end opens a welcome tab.

## What to create

**New file**: `app/src/components/layout/TabStrip.tsx`

```tsx
import { useTabsStore, type Tab, type TabType } from "@/stores/tabs-store";
import { useRequestQuery } from "@/queries/collections";
import { cn } from "@/lib/utils"; // or however cn is imported in this project
import { X, Plus } from "lucide-react";

function tabLabel(tab: Tab, requestData?: { method: string; url: string }): string {
  switch (tab.type) {
    case "welcome": return "Vayu";
    case "settings": return "Settings";
    case "variables": return "Variables";
    case "request":
      if (requestData) return `${requestData.method} ${new URL(requestData.url, "http://x").pathname}`;
      return "Request";
    case "collection": return "📁 Collection";
    case "dashboard": return "⚡ Running";
    case "run": return "🕐 Run";
    default: return tab.type;
  }
}

function TabItem({ tab, isActive }: { tab: Tab; isActive: boolean }) {
  const { focusTab, closeTab } = useTabsStore();
  // For request tabs, fetch label data from query cache (no new network request)
  const requestQuery = useRequestQuery(tab.type === "request" ? tab.entityId : null);
  const label = tabLabel(tab, requestQuery.data ? {
    method: requestQuery.data.method,
    url: requestQuery.data.url,
  } : undefined);

  return (
    <div
      role="tab"
      aria-selected={isActive}
      onClick={() => focusTab(tab.id)}
      className={cn(
        "group flex items-center gap-1.5 px-3 h-full min-w-0 cursor-pointer select-none shrink",
        "border-r border-border/40 text-sm",
        isActive
          ? "bg-background text-foreground"
          : "bg-panel text-muted-foreground hover:text-foreground hover:bg-panel-hover"
      )}
      style={{ minWidth: "80px", maxWidth: "200px" }}
    >
      <span className="truncate min-w-0 flex-1">{label}</span>
      <button
        onClick={(e) => { e.stopPropagation(); closeTab(tab.id); }}
        className="opacity-0 group-hover:opacity-100 rounded p-0.5 hover:bg-surface-raised shrink-0"
        aria-label="Close tab"
      >
        <X size={12} />
      </button>
    </div>
  );
}

export function TabStrip() {
  const { openTabs, activeTabId, openTab } = useTabsStore();

  return (
    <div className="flex items-stretch h-full min-w-0 overflow-x-auto scrollbar-none" role="tablist">
      {openTabs.map((tab) => (
        <TabItem key={tab.id} tab={tab} isActive={tab.id === activeTabId} />
      ))}
      <button
        onClick={() => openTab({ type: "welcome", entityId: null })}
        className="flex items-center justify-center w-8 shrink-0 text-muted-foreground hover:text-foreground hover:bg-panel-hover"
        aria-label="New tab"
      >
        <Plus size={14} />
      </button>
    </div>
  );
}
```

**Notes for the agent:**
- Check how `useRequestQuery` is imported in this project (look at
  `app/src/queries/collections.ts`) — the hook may need an `id` param or
  return from cache.
- Check how `cn` is imported (look at existing components for the pattern).
- Use the actual Tailwind token names from the project — look at
  `app/src/index.css` or any existing component for `bg-panel`,
  `bg-background`, `text-muted-foreground` etc.
- Do not add logic for keyboard shortcuts here; those are wired in `Shell.tsx` (task 6a).

## Acceptance criteria

- `pnpm type-check` passes.
- `pnpm lint` passes.
- The component renders without runtime errors when `openTabs` is empty or
  has multiple entries.

## Files to touch

- `app/src/components/layout/TabStrip.tsx` (new)
