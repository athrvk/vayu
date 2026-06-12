# Task 8a — Create `ContextBar` component

## Context

Repository: `athrvk/vayu`. Work on branch `claude/clever-sagan-b4oTu`.

The context bar is a right-side panel that shows contextual info for the active
request tab. It is hidden for all other tab types.

**Prerequisites**: Task 4a (layout-store), 3a (tabs-store).

## What to create

**New file**: `app/src/components/layout/ContextBar.tsx`

### Visibility rules

- Only visible when `contextBarOpen === true` (from `useLayoutStore`) AND
  the active tab is of type `"request"`.
- For all other tab types (dashboard, settings, etc.) render `null` even if
  `contextBarOpen` is true.

### Width

Fixed at 252px. This is not resizable in v1.

### Content adapts to active request editor sub-tab

The request builder has sub-tabs (Params, Headers, Body, Auth, Pre-request,
Tests). The context bar content changes based on which sub-tab is active.
For v1, implement a simple adapter:

| Active sub-tab | Context bar content |
|---|---|
| Params | Fully resolved URL (variable substitutions highlighted) |
| Auth | Auth inheritance chain label (placeholder text for v1) |
| Pre-request / Tests | Script order note (placeholder text for v1) |
| Body | Effective Content-Type header value |
| Any | Bottom section: all variables in scope with resolved values |

For v1, it's acceptable to start with a simple panel that shows:
1. A header with "Context" and a close button (calls `setContextBarOpen(false)`).
2. A "Variables in scope" section listing resolved variable values.
3. Placeholder sections for the other context types.

The variables-in-scope section uses `useVariableResolver` — check
`app/src/hooks/useVariableResolver.ts` for the API. It exposes
`getAllVariables()` which returns a `Record<string, VariableSource>`.

### Responsive mode (see task 8b for full implementation)

Add a `mode` prop that defaults to `"push"`:

```tsx
interface ContextBarProps {
  mode?: "push" | "overlay";
}
```

In `"overlay"` mode, position the bar absolutely over the response pane:

```tsx
className={cn(
  "flex flex-col shrink-0 border-l border-border bg-panel",
  mode === "overlay"
    ? "absolute right-0 top-0 bottom-0 shadow-lg z-10"
    : "relative"
)}
style={{ width: 252 }}
```

The `mode` prop is set by the parent (`Shell.tsx`) based on window width.

### Skeleton

```tsx
export function ContextBar({ mode = "push" }: ContextBarProps) {
  const { contextBarOpen, setContextBarOpen } = useLayoutStore();
  const { openTabs, activeTabId } = useTabsStore();
  const activeTab = openTabs.find((t) => t.id === activeTabId);

  if (!contextBarOpen || activeTab?.type !== "request") return null;

  const { getAllVariables } = useVariableResolver({
    collectionId: undefined, // TODO: pass from active tab context
  });
  const variables = getAllVariables();

  return (
    <div
      className={cn(
        "flex flex-col shrink-0 border-l border-border bg-panel overflow-y-auto",
        mode === "overlay" ? "absolute right-0 top-0 bottom-0 shadow-lg z-10" : "relative"
      )}
      style={{ width: 252 }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <span className="text-xs font-medium text-foreground">Context</span>
        <button onClick={() => setContextBarOpen(false)} className="text-muted-foreground hover:text-foreground">
          <X size={14} />
        </button>
      </div>

      {/* Variables in scope */}
      <div className="p-3">
        <p className="text-xs font-medium text-muted-foreground mb-2">Variables in scope</p>
        {Object.entries(variables).map(([name, source]) => (
          <div key={name} className="flex justify-between text-xs py-0.5">
            <span className="text-foreground font-mono">{`{{${name}}}`}</span>
            <span className="text-muted-foreground truncate ml-2">{String(source.value)}</span>
          </div>
        ))}
        {Object.keys(variables).length === 0 && (
          <p className="text-xs text-muted-foreground">No variables in scope</p>
        )}
      </div>
    </div>
  );
}
```

## Wire into Shell.tsx

In `app/src/components/layout/Shell.tsx` (task 6a), add the ContextBar next
to the main content:

```tsx
<div className="flex flex-1 overflow-hidden relative">
  <Drawer />
  <main className="flex-1 overflow-hidden flex flex-col">
    {renderTabContent(activeTab)}
  </main>
  <ContextBar mode={windowWidth >= 1200 ? "push" : "overlay"} />
</div>
```

Track `windowWidth` with a `useEffect` on `window.resize`.

## Acceptance criteria

- `pnpm type-check` passes.
- `pnpm lint` passes.
- Context bar is hidden for non-request tabs.
- Renders the variables-in-scope list.
- Close button closes the bar.

## Files to touch

- `app/src/components/layout/ContextBar.tsx` (new)
- `app/src/components/layout/Shell.tsx` (add ContextBar import and usage)
