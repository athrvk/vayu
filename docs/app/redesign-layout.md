# App Shell Redesign — "Pure" Layout (Option C)

Status: **design finalized, pre-implementation**
Mockup: `design-mockup-c.html` (repo root) — interactive, uses real design tokens.

## Summary

The app shell moves from a fixed activity-bar + sidebar + single-screen layout
to a tab-centric layout:

```
┌─ title bar ── open tabs ─────────────── env pill · window controls ─┐
├──────────┬───────────────────────────────────────┬──────────────────┤
│ drawer   │  URL bar (Send · Load Test)           │ context bar      │
│ (collec- ├───────────────────┬───────────────────┤ (adapts to       │
│ tions /  │ REQUEST (left)    │ RESPONSE (right)  │  active request  │
│ history /│ Params Headers …  │ Body Headers …    │  tab)            │
│ vars)    │                   │                   │                  │
├──────────┴───────────────────┴───────────────────┴──────────────────┤
│ dock: 🗂⌘E 🕐⌘H ⚡⌘U │ ● engine · save status · version │ ◧⌘I ⚙   │
└──────────────────────────────────────────────────────────────────────┘
```

- **Tabs live in the title bar** (Arc/Linear style). Request tabs, dashboard
  tabs, and a settings tab share one tab strip.
- **One left drawer, three contents** — Collections (⌘E), History (⌘H),
  Variables (⌘U). Dock buttons swap content; same button toggles closed.
- **Right context bar** (⌘I) — contextual info for the active request.
- **Bottom dock** replaces the activity bar AND the sidebar footer
  (ConnectionStatus + save status move here).
- Request/response split stays **left/right** (as today,
  `RequestBuilderLayout.tsx`).

## Finalized decisions

### Tabs
- **Max open tabs** with LRU auto-close: oldest unmodified tab closes when the
  cap is hit. Tabs shrink as the strip fills, but never below the point where
  the path is legible (method badge + truncated path). Expect iteration here.
- **No unsaved dot.** Autosave is the safety net (see below). Save status
  lives in the dock.
- **Active tab is flush with content**: same `bg-background` as the main
  area, no border-bottom under the active tab; the title bar's bottom border
  runs under inactive tabs only.
- **Settings opens as a tab** (like VS Code's settings editor). It is a
  full server-backed config page (engine config API, restart banner, engine
  restart button — see `SettingsMain.tsx`) and cannot be a modal. Entry
  points: `⌘,` and a `⚙` button at the right end of the dock.
- **Load tests open as a new tab**, never navigate away from the request tab.
  Tab label shows live state (`⚡ GET /users · Running`). The dashboard
  header gets an "Open request" button that focuses/reopens the originating
  request tab (dashboard store already receives `requestInfo` + `requestId`).

### Title bar (OS-aware)
- macOS: native traffic lights (`titleBarStyle: hiddenInset`), ~80px inset
  before the logo/tabs. Inset collapses in fullscreen.
- Windows: native caption buttons via Electron `titleBarOverlay` (gets Win 11
  snap layouts for free).
- Linux: custom caption buttons (as today).
- **Logo visible on all three platforms.**
- Env switcher pill on the right for all platforms (consistency over
  platform purism).
- Drag regions: logo, gap after last tab, spacer before env pill. Every
  interactive child is `no-drag`.

### Autosave (prerequisite work — closes a real data-loss gap)
`useSaveManager.ts` currently clears the pending 3s debounce timer on entity
switch/unmount **without flushing**, so edits made <3s before switching
requests are silently lost. Fixes:
1. Flush pending save on unmount/entity-switch (if `hasChanges`).
2. Flush on tab close — including LRU auto-close, which must never discard
   edits.
3. Flush all pending save contexts on Electron `before-quit` (save-store
   context registry already tracks them).

### Left drawer
- Resizable: drag handle on right edge, clamp 220–480px, double-click handle
  resets to default. Width persisted per drawer view (History defaults wider —
  carries over today's 420px min for URL legibility).
- Scroll position preserved per view (extends navigation store `tabMemory`).
- Drawer stays open during drag-and-drop reordering; never auto-closes
  mid-drag.

### Tree ↔ tab selection sync
- Single source of truth: `selectedRequestId` in navigation store.
- Tree highlight always follows the active tab.
- Clicking a tree request focuses its existing tab if open; otherwise opens
  a new tab (no duplicate tabs per request).
- Auto-reveal (expand ancestors + scroll into view) only when triggered by a
  tab switch — never while the user is interacting with the tree.

### Right context bar
- Content adapts to the active request-editor tab:
  - **Params** → fully resolved URL with variable highlighting
  - **Auth** → auth inheritance chain (which collection contributes what)
  - **Pre-request / Tests** → composed script order (root→leaf collection
    chain + request script)
  - **Body** → effective content-type header
  - Always: variables in scope with resolved values + source scope
- "Last run" entry greys out with a note once the request has been edited
  after that run.
- Responsive: below a width threshold the context bar overlays instead of
  pushing layout; no layout breakage at 1280px.

### Request/response split
- Left/right, as today. Split ratio persisted in localStorage.
- Divider: 1px visual, ~8px hit area, grip dots visible on hover (component
  `ResizableHandle withHandle` already supports this).

### Response viewer
- Empty state carries over unchanged — already handled in
  `ResponseViewer/index.tsx` (icon, "No response yet", ⌘↵ hint, load-test
  dashboard button).

### Bottom dock
- Height ≥32px for sane hit targets.
- Left: drawer switchers (Collections/History/Variables) with shortcuts.
- Middle: ambient status — engine connection (replaces sidebar
  `ConnectionStatus` placement), save status, version.
- Right: Context bar toggle (⌘I), Settings (⚙ → opens settings tab).
- Dock button "active" state means "this drawer is open", which is distinct
  from the active tab — hierarchy (smaller, bottom, secondary) carries that
  distinction.

## Migration notes

- `ActivityBar` in `Sidebar.tsx` retires; `SidebarPanel` content components
  (CollectionTree, HistoryList, VariablesCategoryTree) move into the drawer
  unchanged.
- `SettingsCategoryTree` moves inside the settings tab as a local sidebar.
- Navigation store gains tab management (`openTabs`, `activeTabId`,
  open/close/focus actions); `tabMemory` concept transfers to drawer view
  state.
- `ConnectionStatus` + save status indicator move from sidebar footer to dock.
- `navigateToDashboard()` becomes "open dashboard tab".
