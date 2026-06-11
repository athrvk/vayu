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
│ dock: 🗂 🕐 ⚡ │ ● engine · save status · version │ ◧ context · ⚙  │
└──────────────────────────────────────────────────────────────────────┘
```

- **Tabs live in the title bar** (Arc/Linear style). Tabs are typed — see
  below. Every main screen that exists today maps to a tab type.
- **One left drawer, three contents** — Collections, History, Variables.
  Dock buttons swap content; same button toggles closed.
- **Right context bar** — contextual info for the active request tab.
- **Bottom dock** replaces the activity bar AND the sidebar footer
  (ConnectionStatus + save status move here).
- Request/response split stays **left/right** (as today,
  `RequestBuilderLayout.tsx`).

## Tab model

Tabs are typed. Every screen in today's `Shell.renderMainContent()` switch
maps to a type:

| Type | Content | Identity / dedupe | Label |
|---|---|---|---|
| `request` | RequestBuilder | one per `requestId` | `GET /users` |
| `collection` | CollectionDetail (Info/Variables/Auth/Script) | one per `collectionId` | `📁 My API` |
| `dashboard` | Live load test (LoadTestDashboard) | **max one live** (see scope note) | `⚡ GET /users · Running` |
| `run` | HistoryDetail (completed run) | one per `runId` | `🕐 GET /users · 200` |
| `variables` | VariablesMain table editor | singleton; drawer category selection retargets it | `⚡ Variables` |
| `settings` | SettingsMain (full config page incl. engine restart) | singleton | `⚙ Settings` |
| `welcome` | WelcomeScreen (quick actions, recents) | singleton, transient | `Vayu` |

Store shape (replaces `activeScreen`/`tabMemory` resolution):

```ts
interface Tab { id: string; type: TabType; entityId: string | null }
// navigation store: openTabs: Tab[], activeTabId: string | null
// + openTab / closeTab / focusTab / replaceTab actions
```

Rules:

- **Welcome is the zero-tab state.** When `openTabs` is empty the main area
  renders WelcomeScreen. The `+` button opens a welcome tab; picking a
  request/action from it **replaces** that welcome tab in place.
- **Max open tabs with LRU auto-close**: oldest non-active tab closes when
  the cap is hit. Exempt from auto-close: the active tab, a live `dashboard`
  tab, and any tab with an unflushed save (flush first — see Autosave).
  Tabs shrink as the strip fills, but never below method badge + legible
  truncated path. Expect iteration here.
- **No unsaved dot.** Autosave is the safety net. Save status lives in the
  dock.
- **Active tab is flush with content**: same `bg-background` as the main
  area, no border-bottom under the active tab; the title bar's bottom border
  runs under inactive tabs only.
- **Open tabs persist across restart** (zustand `persist`, same as split
  ratio and drawer widths). Dead entity IDs (deleted request/run) drop
  silently on restore.

### Load test / dashboard scope (v1)

`dashboard-store` is a singleton (single `currentRunId`, single metrics
buffer). v1 keeps it: **at most one live dashboard tab**. Starting a load
test opens it as a new tab — never navigates the request tab away. When the
run completes the tab keeps showing the final report (current dashboard
behavior); once closed, the run reopens from History as a `run` tab.
Multiple *completed* run tabs are fine (they read persisted stats). Keying
the dashboard store by runId for concurrent live runs is explicitly out of
scope for v1.

"Open request" affordance: dashboard and run-detail headers get a button
that focuses (or reopens) the originating request tab. Note: the dashboard
store receives `requestInfo` (method/URL) but **not** `requestId` — the
button resolves `requestId` from the run record (runs query by `runId`).

## Keyboard shortcuts (full table)

`⌘` = Ctrl on Windows/Linux. Existing bindings that survive unchanged:
`⌘S` save, `⌘↵` send, `⌘,` settings (new but standard).

| Binding | Action | Note |
|---|---|---|
| `⌘W` | Close tab | **Rebind** — today closes window (menu role). Window close becomes `⇧⌘W` |
| `⌘1`–`⌘9` | Jump to tab N | Browser muscle memory |
| `Ctrl+Tab` / `Ctrl+⇧Tab` | Cycle tabs | |
| `⌘T` | New tab (welcome tab) | |
| `⇧⌘E` | Drawer: Collections | plain `⌘E` is "Use Selection for Find" on macOS; shifted tier avoids the OS |
| `⇧⌘H` | Drawer: History | **plain `⌘H` is macOS Hide** (`role: "hide"` in our menu) — must not be used |
| `⇧⌘U` | Drawer: Variables | |
| `⌘B` | Toggle drawer (last view) | VS Code muscle memory |
| `⌘I` | Toggle context bar | no rich-text conflict in app; suppressed while Monaco has focus |
| `⌘,` | Open settings tab | |
| `⌘S` | Force save | existing, `Shell.tsx` handler moves with shell |
| `⌘↵` | Send request | existing, `RequestBuilderLayout.tsx` |

## Title bar (OS-aware) — includes cleanup mandate

**Current state is contradictory and the redesign must resolve it**:
`electron/main.ts` configures native `titleBarOverlay` (height 40) for BOTH
Windows and Linux, while `TitleBar.tsx` simultaneously renders custom HTML
min/max/close buttons for non-mac. Both control sets are active today. The
overlay height (40px) also mismatches the actual bar (`h-8` = 32px).

Resolution per platform:

- **macOS**: native traffic lights (`titleBarStyle: "hidden"`),
  `trafficLightPosition` re-tuned to the final bar height. Inset (~80px)
  before logo/tabs; collapses in fullscreen (lights auto-hide).
- **Windows**: native `titleBarOverlay` (gets Win 11 snap layouts free).
  Remove the custom HTML buttons. Overlay `height` must equal the final
  bar height.
- **Linux**: **disable `titleBarOverlay`** (DE support is inconsistent);
  keep the custom HTML buttons from `TitleBar.tsx` (IPC already wired).
- **Bar height: 38px** (tabs need more than today's 32px; overlay height
  and traffic-light position derive from this one constant).
- Overlay colors are currently hardcoded `#1a1a1a`/`#ffffff` — neither
  matches panel tokens (`#111113` dark / `#f2f0eb` light). Drive them from
  the design tokens and update on theme change (hook exists in `main.ts`).
- **Logo visible on all three platforms.**
- Env switcher pill on the right for all platforms.
- Drag regions: logo, gap after last tab, spacer before env pill. Every
  interactive child is `no-drag`.

## Autosave (prerequisite work — closes a real data-loss gap)

`useSaveManager.ts` currently clears the pending 3s debounce timer on entity
switch/unmount **without flushing**, so edits made <3s before switching
requests are silently lost. Fixes:

1. Flush pending save on unmount/entity-switch (if `hasChanges`).
2. Flush on tab close — including LRU auto-close, which must never discard
   edits.
3. Flush all pending save contexts on Electron `before-quit` (save-store
   context registry already tracks them; the settings tab registers its own
   context and is covered by the same drain).

## Left drawer

- Resizable: drag handle on right edge, clamp 220–480px, double-click handle
  resets to default. Width persisted per drawer view (History defaults wider —
  carries over today's 420px min from `Shell.tsx` for URL legibility).
- Scroll position preserved per view.
- Drawer stays open during drag-and-drop reordering; never auto-closes
  mid-drag.
- Drawer interactions open tabs: tree request click → `request` tab;
  collection name click → `collection` tab; run click → `run` tab (or
  focuses the live `dashboard` tab if that run is live); variables category
  click → retargets the singleton `variables` tab.

## Tree ↔ tab selection sync

- Single source of truth: the active tab's `entityId`.
- Tree highlight always follows the active tab.
- Clicking a tree request focuses its existing tab if open; otherwise opens
  a new tab (no duplicate tabs per entity).
- Auto-reveal (expand ancestors + scroll into view) only when triggered by a
  tab switch — never while the user is interacting with the tree.

## Right context bar

- Only rendered for `request` tabs (hidden/disabled for other tab types).
- Content adapts to the active request-editor sub-tab:
  - **Params** → fully resolved URL with variable highlighting
  - **Auth** → auth inheritance chain (which collection contributes what)
  - **Pre-request / Tests** → composed script order (root→leaf collection
    chain + request script)
  - **Body** → effective content-type header
  - Always: variables in scope with resolved values + source scope
- "Last run" entry greys out with a note once the request has been edited
  after that run.

### Responsive rule (window `minWidth` is 1024 — `main.ts`)

The request/response split needs ~680px to stay usable (two ≥30% panes,
`RequestBuilderLayout.tsx`). Therefore:

- **≥1200px window width**: context bar pushes layout (drawer + context +
  content all side-by-side).
- **<1200px**: context bar switches to **overlay** mode (floats over the
  response pane, does not push). The drawer always pushes — it is primary
  navigation.
- At the 1024 floor: drawer (≤480) + content remains usable; context is
  overlay-only. No layout breakage at any reachable window size.

## Request/response split

- Left/right, as today. Split ratio persisted in localStorage.
- Divider: 1px visual, ~8px hit area, grip dots visible on hover (component
  `ResizableHandle withHandle` already supports this).

## Response viewer

- Empty state carries over unchanged — already handled in
  `ResponseViewer/index.tsx` (icon, "No response yet", ⌘↵ hint, load-test
  dashboard button).
- `response-store` is already keyed by requestId (`Map<string,
  StoredResponse>`) — responses survive tab switches with no extra work.

## Bottom dock

- Height ≥32px for sane hit targets.
- Left: drawer switchers (Collections/History/Variables) with shortcuts.
- Middle: ambient status — engine connection (replaces sidebar
  `ConnectionStatus` placement), save status, version.
- Right: Context bar toggle (⌘I), Settings (⚙ → opens settings tab).
- Dock button "active" state means "this drawer is open", which is distinct
  from the active tab — hierarchy (smaller, bottom, secondary) carries that
  distinction.

## Store architecture (refactor alongside the redesign)

Audit of all 10 stores (June 2026). Principle: **`stores/` holds
cross-cutting shell state only; module-local UI state co-locates with its
module** (matches the feature-organized `modules/` convention).

Target layout:

```
stores/                      # cross-cutting only
  tabs-store.ts              # NEW — openTabs, activeTabId (persisted)
  layout-store.ts            # NEW — drawer view/open/per-view widths,
                             #       context bar open, split ratios (persisted)
  session-store.ts           # NEW — activeEnvironmentId, activeCollectionId
                             #       (split out of variables-store; consumed by
                             #       env pill + request execution)
  engine-store.ts            # connection + restart-required (merges
                             #       engine/engine-connection-store with the
                             #       restart state from settings-store)
  save-store.ts              # + single runSave() helper, + flushAll()
  response-store.ts          # + LRU cap (aligned with tab cap)
  live-run-store.ts          # renamed dashboard-store, contract unchanged
  import-modal-store.ts      # kept; exported from the barrel (currently isn't)

modules/collections/store.ts # expandedCollectionIds
modules/history/store.ts     # filters/search/sort + filterRuns()
modules/variables/store.ts   # selectedCategory
modules/settings/store.ts    # selectedCategory
```

Cleanups (grep-verified, no consumers):

- Delete dead state: `isSavingCollection`/`isSavingRequest`
  (collections-store), `isDeletingRun` (history-store), `isEditing`
  (variables-store).
- Delete unused alias actions in variables-store: `selectCategory`,
  `setActiveEnvironment` (only the `setSelectedCategory` /
  `setActiveEnvironmentId` variants are used).
- Deduplicate save orchestration: the `startSaving → save → completeSave →
  setTimeout(idle)` sequence is currently written 4× (`triggerSave` twice,
  `useSaveManager.performSave`, `SettingsMain.handleSave`). One internal
  `runSave()` in save-store owns it; `flushAll()` (for before-quit and tab
  close) reuses it.
- `navigation-store` (327 lines) dissolves entirely into `tabs-store` +
  `layout-store`; `tabMemory` and `resolveActiveScreen` have no successor.

Conventions to codify:

- Server state never lives in zustand (TanStack Query owns it — already
  true; keep it that way).
- Persisted stores use `persist` + `partialize`, key prefix `vayu.`, and a
  `version` field for future migrations. (Today only variables-store
  persists, under an unprefixed key — migrate or accept one-time reset.)
- No alias actions; one verb-first naming convention (`setX`, `openX`).
- Pure helpers co-locate with their store (`filterRuns` is the model).



- `ActivityBar` in `Sidebar.tsx` retires; `SidebarPanel` content components
  (CollectionTree, HistoryList, VariablesCategoryTree) move into the drawer
  unchanged.
- `SettingsCategoryTree` moves inside the settings tab as a local sidebar.
- Navigation store: `openTabs`/`activeTabId` + open/close/focus/replace
  actions replace `activeScreen` + `resolveActiveScreen` + `tabMemory`.
  Drawer view + per-view width/scroll state replace `activeSidebarTab` +
  `sidebarPanelOpen`.
- **Call-site inventory required**: every `navigateTo*` consumer changes
  meaning (tree clicks, history clicks, welcome quick-actions,
  `navigateToDashboard` in request-builder, `navigateBack` in dashboard
  header, ResponseViewer's "View Load Test Dashboard" button). Grep for
  `useNavigationStore` before estimating.
- `ConnectionStatus` + save status indicator move from sidebar footer to
  dock.
- `ImportModal` stays mounted at shell level (unchanged).
