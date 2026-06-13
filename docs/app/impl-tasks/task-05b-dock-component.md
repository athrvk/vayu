# Task 5b — Create `Dock` component

## Context

Repository: `athrvk/vayu`. Work on branch `claude/clever-sagan-b4oTu`.

The `Dock` is the bottom bar that replaces the sidebar footer (`ConnectionStatus`)
and the activity bar (drawer view switchers). It has three zones:

```
[Collections] [History] [Variables]  |  ● engine  Saved  v1.2.3  |  [◧ Context] [⚙ Settings]
```

Height: ≥32px. It reads from `useLayoutStore` (task 4a), `useEngineStore` (task 2c),
and `useSaveStore`.

## What to create

**New file**: `app/src/components/layout/Dock.tsx`

### Left zone — drawer switchers

Three icon-buttons. Each calls `useLayoutStore().activateDrawerView(view)`.
Active state: the button's view matches `drawerOpen && drawerView` (both
conditions must be true).

```tsx
const drawerButtons: { view: DrawerView; icon: React.ReactNode; label: string; shortcut: string }[] = [
  { view: "collections", icon: <FolderOpen size={15} />, label: "Collections", shortcut: "⇧⌘E" },
  { view: "history",     icon: <Clock size={15} />,      label: "History",     shortcut: "⇧⌘H" },
  { view: "variables",   icon: <Zap size={15} />,        label: "Variables",   shortcut: "⇧⌘U" },
];
```

Use Lucide icons (`FolderOpen`, `Clock`, `Zap` or similar — match what
existing components use). Wrap each in a `<Tooltip>` showing the label and
shortcut (check how tooltips are done in existing Dock/status components).

### Middle zone — ambient status

```tsx
// Engine connection indicator
<span className={cn("flex items-center gap-1 text-xs", isEngineConnected ? "text-green-500" : "text-red-500")}>
  <span className="w-1.5 h-1.5 rounded-full bg-current" />
  {isEngineConnected ? "Connected" : "Disconnected"}
</span>

// Save status
<span className="text-xs text-muted-foreground">
  {saveStatus === "saving" && "Saving…"}
  {saveStatus === "saved" && "Saved"}
  {saveStatus === "error" && <span className="text-destructive">Save failed</span>}
</span>

// App version (read from import.meta.env.VITE_APP_VERSION or package.json — check how it's done in existing components)
```

### Right zone — toggles

```tsx
// Context bar toggle
<button onClick={() => toggleContextBar()} aria-label="Toggle context bar (⌘I)"
  className={cn(isContextBarOpen ? "text-foreground" : "text-muted-foreground")}>
  <PanelRight size={15} />
</button>

// Settings tab
<button onClick={() => openTab({ type: "settings", entityId: null })} aria-label="Settings (⌘,)">
  <Settings size={15} />
</button>
```

`openTab` comes from `useTabsStore` (task 3a).

### Full component skeleton

```tsx
export function Dock() {
  const { drawerOpen, drawerView, activateDrawerView, contextBarOpen, toggleContextBar } = useLayoutStore();
  const { isEngineConnected } = useEngineStore();
  const { status: saveStatus } = useSaveStore();
  const { openTab } = useTabsStore();

  return (
    <div className="flex items-center h-8 px-2 gap-2 border-t border-border bg-panel shrink-0">
      {/* Left */}
      <div className="flex items-center gap-0.5">
        {drawerButtons.map(({ view, icon, label, shortcut }) => (
          <DockButton key={view}
            active={drawerOpen && drawerView === view}
            onClick={() => activateDrawerView(view)}
            tooltip={`${label} ${shortcut}`}
          >
            {icon}
          </DockButton>
        ))}
      </div>

      {/* Middle — flex-1 centred */}
      <div className="flex-1 flex items-center justify-center gap-4">
        {/* engine + save + version */}
      </div>

      {/* Right */}
      <div className="flex items-center gap-0.5">
        {/* context bar toggle + settings */}
      </div>
    </div>
  );
}
```

## Notes for the agent

- Check existing components for how `Tooltip` is imported/used in this project
  (look in `app/src/components/ui/`).
- Check how the app version is read (look in `App.tsx` or any component that
  shows a version string).
- Use `useEngineStore` if task 2c is done, or `useEngineConnectionStore` if not.
  Check which hook is available.
- Dock height is `h-8` (32px) which matches the title bar constant — use this.

## Acceptance criteria

- `pnpm type-check` passes.
- `pnpm lint` passes.
- All three drawer buttons render and call `activateDrawerView`.
- The context bar toggle button renders and calls `toggleContextBar`.
- The settings button calls `openTab({ type: "settings", entityId: null })`.

## Files to touch

- `app/src/components/layout/Dock.tsx` (new)
