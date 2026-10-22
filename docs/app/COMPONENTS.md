---
description: >-
  How the Vayu desktop app's React code is laid out - the modules/ and components/ split, and where each part of the UI lives.
---

# Component Architecture

The React component structure of the Vayu app (`app/src`).

The UI is organized into two top-level trees:

- **`components/`** - app-shell layout, status, shared response rendering, and the `ui/` primitive library. Cross-cutting pieces not owned by a single feature.
- **`modules/`** - feature modules, each self-contained (its own components, and where needed `context/`, `hooks/`, `utils/`, `shared/`): `request-builder`, `collections`, `dashboard`, `history`, `variables`, `settings`, `welcome`.

State lives outside components: **Zustand** stores (`stores/`) for UI/navigation state, **TanStack Query** (`queries/`) for server state from the engine.

## Component Hierarchy

```
<App />                                  // App.tsx - mounts providers, kicks off health/prefetch queries, OS theme sync
├── <TitleBar />                         // components/layout/TitleBar.tsx - --titlebar-height drag region: icon + centered search bar + env pill
│   ├── AppIcon (Windows and Linux - the application-menu button; the system-menu control on Windows)
│   ├── <CommandSearchBar />             // Input-shaped trigger for the ⌘K palette; never its own search
│   └── EnvPill + WindowControls (Linux only; Windows native overlay; macOS traffic lights)
├── <RecoveryBanner />                   // components/shared/RecoveryBanner.tsx - only when the engine restored or deleted the database
├── <UpdateBanner />
├── <KeepAwakePrompt />                  // components/shared/KeepAwakePrompt.tsx - asks once about a run long enough for the machine to sleep under it (#1357)
└── <Shell />                            // components/layout/Shell.tsx - tab-centric layout with drawer + context bar
    ├── <ImportModal />                  // modules/collections/ImportModal.tsx - global overlay, open-state in a store
    ├── <CommandPalette />               // modules/palette/ - ⌘K overlay; open-state in layout-store
    ├── <ActivityRail />                 // components/layout/ActivityRail.tsx - w-[var(--rail-width)]; the six Drawer-view buttons; F6 region "rail"
    ├── <Drawer />                       // components/layout/Drawer.tsx - resizable 220–480px; single left nav; switches views
    │   ├── <CollectionTree />           //   collections view (default)
    │   ├── <HistoryList />              //   history view
    │   ├── <VariablesCategoryTree />    //   variables view
    │   ├── <ServicesPanel />            //   services view - modules/services/
    │   ├── <TrashList />                //   trash view - modules/trash/
    │   └── <SettingsCategoryTree />     //   settings view
    ├── <TabStrip />                     // Open tabs + "+" button - over main+context, left edge = drawer edge
    ├── main content (switched on active tab type)
    │   ├── <WelcomeScreen />            // type="welcome"     modules/welcome/
    │   ├── <RequestBuilder />           // type="request"     modules/request-builder/
    │   ├── <CollectionDetail />         // type="collection"  modules/collections/CollectionDetail/
    │   ├── <LoadTestDashboard />        // type="dashboard"   modules/dashboard/
    │   ├── <HistoryDetail />            // type="run"         modules/history/main/
    │   ├── <VariablesMain />            // type="variables"   modules/variables/main/
    │   ├── <SettingsMain />             // type="settings"    modules/settings/main/ (content pane; tree is in the Drawer)
    │   ├── <InboxView />                // type="inbox"       modules/inbox/
    │   └── <MockServerView />           // type="mock-server" modules/mock-server/
    ├── <ContextBar />                   // components/layout/ContextBar.tsx - 252px; sections from context-bar/registry.ts; push ≥1200px / overlay <1200px
    ├── <ContextRail />                  // components/layout/ContextRail.tsx - w-[var(--rail-width)]; one icon per applicable context-bar section
    └── <Dock />                         // components/layout/Dock.tsx - status in the centre (engine/save state, pending restart); per-tab view controls on the right (request tabs)
```

## App Shell

### `App` (`App.tsx`)

Root component. Renders `<TitleBar />` over `<Shell />`. On mount it wires up app-wide concerns via hooks/queries: OS/Electron theme sync (`useElectronTheme`), engine health polling (`useHealthQuery`), and prefetching of server state (`usePrefetchCollectionsAndRequests`, `usePrefetchRuns`, `useScriptCompletionsQuery`).

Those three are prefetches in the literal sense - they fill a cache once and do not observe it. The root deliberately mounts no polled query but `useHealthQuery`: an observer here lives for the whole session, so mounting `useRunsQuery` for its cache-warming side effect kept a 5s runs poll running with History closed and nothing at the root reading the result (#1150).

### Error Handling (`errors/`)

`main.tsx` wraps the whole render tree in `ErrorBoundary` (`errors/ErrorBoundary.tsx`), and registers `window.addEventListener("error")` and `("unhandledrejection")` beside it (issue #1558) - the boundary catches what a component's render throws, the two window listeners catch what it cannot (an event handler, a timer, a raw DOM listener, a promise nobody awaited). All three funnel through `errors/error-logger.ts`'s `logError` / `logApiError`. Inside Electron, `logError` forwards `{level, cat, msg, err, fields}` over the one-way `electronAPI.log` channel (`preload.ts` → `log:record` IPC → `log-ipc.ts` in the main process), which validates the shape, redacts and applies the engine's `logLevel` floor before it reaches `app_<stamp>.log` as a `src: "renderer"` record - see [Engine Logging](../engine/logging.md). Outside Electron (the vite-hosted sweep/probe harnesses `app/CLAUDE.md` describes, where `window.electronAPI` is absent) it keeps writing to `console.error` / `.warn` / `.info` by severity, the behaviour this issue found already in place. `ErrorBoundary`'s own fallback UI still renders locally either way - the log path only decides where the record goes, never whether the user sees the error.

### The two chrome rows

Top chrome is 32px + 32px, and the split is what makes both halves work:

```
[ icon | ............ centered search bar ............ | env switcher | controls ]  <- title row, --titlebar-height
[ drawer header band | tab strip over main + context, left edge = drawer edge    ]  <- --tabstrip-height
[ drawer body        | main content                    | context bar             ]
[ dock                                                                           ]
```

The title row belongs to the **window** (it is what drags it, and what the macOS traffic lights and the Windows caption overlay are drawn into); the second row belongs to the **content**. Tabs switch the main area and the context bar and never the drawer, so the strip is scoped to that column and its left edge follows the drawer's resize handle - it is the drawer's flex sibling, so there is no width to keep in sync. The drawer's own half of the row is `DrawerPanel`'s header band.

Both rows are tokenized: `--titlebar-height` (mirrored in `electron/constants.ts`, which sizes the real window frame and cannot read CSS) and `--tabstrip-height` (renderer-only - nothing the main process draws is that tall). `titlebar-height.test.ts` holds each token to its readers (and `GRAPHQL_PANE_HEADER_HEIGHT`, the JS twin of `--spacing-band`), and a top-anchored toast subtracts **both** (`constants/toast.ts`).

Tabs used to live in the title row. They are content-width and overflow into a dropdown, so every pixel another control took there converted directly into overflowed tabs - which is why a search bar could not simply be added beside them.

### `TitleBar` (`components/layout/TitleBar.tsx`)

Custom window title bar (Electron frameless window, `--titlebar-height`). Renders nothing outside Electron - there is no window chrome to draw. A 3-column grid (`1fr auto 1fr`), so the search bar is centred on the *window* rather than on whatever space the two clusters leave.

- **All platforms:** `NavigationControls` (Back / Forward, leading edge, issue #1245), `<CommandSearchBar />` (centre), `EnvPill` (right).
- **macOS:** Native traffic light inset (`--traffic-light-inset`, 104px left); no HTML window controls.
- **Windows:** App icon as the application-menu button on left click and the system-menu control on right click (left); native window overlay, no HTML controls in the bar.
- **Linux:** App icon as the application-menu button (left); custom HTML min/max/close buttons (right).

`AppIcon` is where the application menu is reachable at all on Windows and Linux (issue #1361): the window is frameless, so neither platform draws a menu bar, and the template `createMenu` installs contributed accelerators and nothing else there - Help > Documentation, About Vayu and Check for Updates had no mouse route. Left click, Enter, Space, `APP_MENU_CHORD` (F10) and a tap of Alt all send `window:appMenu`, and main pops `Menu.getApplicationMenu()` at the icon: one template, two surfaces, no second menu in the renderer. Both keyboard routes ask `isModalOpen()` first, and the Alt tap is a state machine (`lib/alt-tap.ts`) rather than a `Chord`, because Alt held as a modifier - Alt+Tab, Alt+← - is not a menu request. macOS renders no button and registers no listener; its menu bar draws the same template already. → `app-icon-menus.test.tsx`, `electron/app-menu.test.ts`.

The entire bar is marked as a drag region (`WebkitAppRegion: "drag"`) except for interactive elements, which explicitly set `no-drag` - a drag area ignores every pointer event, so a control that forgets is dead rather than merely awkward. Opting out per control or per cluster is fine; opting out a wrapper that spans the row's slack is not, because that slack is what the window is dragged by. → `TitleBar.search-bar.test.tsx`.

The env switcher's accessible name is its visible text behind an `sr-only` "Environment: " prefix ("Environment: Staging"), never an `aria-label`: a label replaces the visible name, so a speech-control user saying "click Staging" matched nothing (WCAG 2.5.3). → `TitleBar.search-bar.test.tsx`.

The env switcher's menu is controlled by `env-switcher-store` (issue #2115) rather than left to Radix: the import's toast action **Choose environment** has no other way to open it. The menu's own open and close write back to the store. → `TitleBar.env-switcher.test.tsx`.

`NavigationControls` puts Back and Forward at the leading edge, each a `TooltipIconButton` with its own `no-drag`, disabled when its half of `navHistory` is empty (`canGoBack` / `canGoForward`), and a tooltip naming its chord (`GO_BACK_CHORD` / `GO_FORWARD_CHORD`).

The logo is imported as a module (`@shared/icon_png/...`), not referenced as `/icon.png`. With `base: "./"`, a root-absolute path resolves against the filesystem root under the packaged `file://` build and silently fails to load - it only appears to work in dev, where Vite serves it over HTTP.

### `CommandSearchBar` (`components/layout/CommandSearchBar.tsx`)

The palette's visible entry point, in the title row. A `<button>` styled as an input: it looks like a field because that is what makes ⌘K discoverable, but typing happens in the palette's own input - a real field here would be a second query state and a second ranked list to keep in step. Clicking sets `paletteOpen`; the hint it prints is one `Kbd` cap per key from `chordKeys(PALETTE_CHORD)` (`constants/shortcuts.ts`), the same constant `CommandPalette`'s listener matches, so the bar cannot advertise a chord nothing handles.

### `TabStrip` (`components/layout/TabStrip.tsx`)

Horizontal row of open tabs plus a "+" button, rendered by `Shell` over the content column (not in the title bar). Reads from `useTabsStore` (open tabs, active tab, add/close/focus methods). Takes its height from `--tabstrip-height` and carries no `app-region` markers - nothing down here drags the window.

Labels and icons come from `tab-descriptors.ts`, a sibling module rather than this file, because the command palette lists the same tabs and must name them identically - a tab that reads "GET /v1/orders" in the strip and "Request" in the palette is two answers to one question.

- **One tab per open entity**, deduplicated per type and `entityId`. Tabs show: icon (method badge for requests, folder for collections, lightning for dashboard, etc.), label (request method + URL path / collection name / screen name). A request tab with no name of its own is titled from the URL as the Params panel's **Sends** line resolves it (`request-builder/utils/sends-url.ts`, #2637), so a `:name` path row's value and `disableUrlEncoding` read the same in both.
- **Max 12 tabs** with LRU eviction when exceeding: the least recently focused tab (`tabFocusedAt`, not strip order) goes first; dashboard tabs are exempt from eviction. Dirty tabs (unsaved) are skipped during eviction (autosave is the safety net).
- **Middle-click closes** a tab (browser-like).
- **An empty strip says what to do, and does not collapse** (issue #1688). With no tabs open it was a blank 32px band with a lone "+" - a user whose last tab had just closed had nothing on screen saying where the app went. It now carries a muted line, "Open a request from the sidebar, or press <chord>", with the chord read from `constants/shortcuts.ts` through `formatChord` so the modifier is this platform's. The band itself stays: its height is the same token the drawer's header band reads, so a strip that disappeared would leave that header as a step in the rule running across the window and would jump the content area by a band's height at the moment the last tab closed. → `TabStrip.empty.test.tsx`
- **No unsaved dot** - autosave ensures safety.
- **Keyboard support:** ⌘1–9 jump to tab, bound to the physical digit row (`e.code`) rather than to the character it types, so they work on AZERTY and every other shifted-digit layout; displayed via dock shortcuts. ⇧⌘] and ⇧⌘[ sit beside them, matched by `code` (`BracketRight`/`BracketLeft`) for the same layout reason, and step to the next and previous open tab. All four chords are `Shell`'s, not the strip's, and all four **activate** the destination tab - the bracket pair through `focusAdjacentTab` (`tabs-store.ts`, `openTabs` order, wrapping at both ends), the digits by direct index - where the strip's own Left/Right move only DOM focus along its roving tabindex and leave the active tab untouched.
- **The strip is one Tab stop, and stays one.** Roving tabindex: exactly one tab carries `tabIndex=0`, Left/Right/Home/End move focus within the strip, and Enter or Space activates - focus moves *without* activating, so skating past a dashboard tab mounts nothing. The stop is component state, not a DOM write (#1856): `useRovingStop` (`components/layout/useRovingStop.ts`) holds it, follows the active tab, and lets an arrow press move it away until the active tab changes or the arrowed-to tab closes or drops out of the strip, when it falls back to the active tab. It reaches `TabItem` as `isRovingStop`, which `tabItemPropsEqual` compares, so the memo re-renders the tab that gains the stop and the one that loses it. Written onto the element instead, the stop sat on top of a prop React never re-applied: arrow then click left two `tabindex="0"` tabs, and arrow then Delete left none. Delete or Backspace closes the focused tab (both keys, since a Mac's "delete" reports `Backspace`). → `TabStrip.keyboard.test.tsx`
- **Alt+Arrow / Home / End move the focused tab** (issue #2038). Alt+← and Alt+→ move it one place, Alt+Home and Alt+End to either end: `MOVE_TAB_*_CHORD` in `constants/shortcuts.ts`, matched by `matchesChord` in the strip's own `onKeyDown` rather than at `window`, because they act on the *focused* tab and only the strip knows which that is. The target is read from the focused tab's place in the store's `openTabs`, not among the tabs that fit, so a move is a statement about the whole list; at an end the move is a no-op and the key is still taken. The handler goes through `moveTabAndFocus` (`tab-focus.ts`), which flushes the write and refocuses the tab - Chromium drops focus to `<body>` from an element React reinserts - and moves the roving stop with it, without activating the tab. These are the one overlap with `Shell`: off macOS Go back and Go forward are the same Alt+←/→. The strip resolves it as the tree does, taking the chord only while a `role="tab"` element has focus and calling `stopPropagation` so `Shell`'s window listener never sees it; Go back stays reachable from every other focus, the title-bar buttons, the palette and mouse buttons 3 and 4, and on macOS it is ⌘[ and nothing collides. The palette carries **Move tab left** and **Move tab right** (`lib/commands/registry.ts`), which act on the *active* tab where the chord acts on the focused one - the same split Close Others records; Home and End are repeats of those and have no row (`palette-parity.test.ts`). → `TabStrip.keyboard.test.tsx`, `tabs-store.move.test.ts`
- **Tabs drag to reorder** (issue #2039), the pointer half of moving a tab beside the Alt+Arrow chords. `useTabStripDnd` (`components/layout/useTabStripDnd.ts`) is `useTreeDnd` with everything tree-shaped removed: the press-versus-drag gesture (`lib/drag/drag-gesture`, ~4px, never a timer, so a click that wobbles is still a click), the slot maths (`lib/drag/drop-slot`) and pointer capture on the pressed tab. A drop is one `moveTabAndFocus` call, the keyboard path's own, and then hands the roving Tab stop to the moved tab; the active tab is not changed and a drop never stamps focus for the LRU. The slot indexes the tabs the strip *renders*, and a slot lands right after the visible tab to its left (the end slot after the last rendered tab, which is the end of the list when the active tab was surfaced from the menu), so a drop beside a run of hidden tabs lands at the head of that run and the dropped tab stays on screen. Whether a slot draws a line is decided in store terms, on the landing index, not on the visible neighbours: a slot that is a real move across a gap of hidden tabs shows its indicator. **No edge auto-scroll**: the strip is `overflow-hidden` on purpose and what does not fit lives in the "+N" menu, so there is nothing to scroll; `slotAt` counts midpoints, so a pointer over the "+N" trigger or the "+" button names the slot after the last tab with no clamping. Tabs inside the overflow menu are not draggable (a Radix menu captures the pointer and closes on press); choosing one surfaces it in the strip, where it drags like any other. A **release above or below the strip cancels**, as do Escape (a `window` listener while a drag is live) and `pointercancel`; a completed or cancelled drag swallows the one trailing click in `onClickCapture` (`consumeClick`), or the dropped tab would activate. A press on the close control (`data-tab-close`) is not a press on the tab. The dragged tab dims (`opacity-50`, the tree's drag-source class) and the slot is a 2px `DropIndicator` inside the tab beside it; no ghost, no raised surface, and no slide - React re-keys the moved tab and the tabs reflow, so the only motion is the opacity transition `TabItem` already had, and nothing new needs a `prefers-reduced-motion` guard. **The state reaches `TabItem` through `TabStripDndContext`** (`TabStripDndContext.ts`: `draggingId`, the tab and edge the line is drawn on, and one stable handlers object whose tab id is read from `data-tab-id`), not props, so `tabItemPropsEqual` is unchanged: the value is the same object at rest and changes only while a drag is live, which is what keeps `TabStrip.render-count.test.tsx` as it was. The indicator is `aria-hidden` and lives inside a tab, never as a `role="tab"` sibling. → `TabStrip.dnd.test.tsx`
- **A close from the keyboard hands focus on.** The tab holding focus is the one that unmounts, so closing it without claiming focus dropped the user to `<body>` and the next Tab restarted from the top of the document (#1218). Both keyboard paths - Delete/Backspace here and ⌘W from wherever focus is - go through `closeTabFromKeyboard` (`tab-focus.ts`), which focuses the store's own choice of next active tab, or the "+" button (`data-tab-new`) when the last tab was the one closed. It flushes the store write first: the strip renders only the tabs that fit, so the tab that becomes active can be one the overflow menu was holding a moment ago. The mouse paths are untouched - a click has already put focus where the user meant it. → `TabStrip.keyboard.test.tsx`, `Shell.close-tab-focus.test.tsx`
- **Section-tab strips share the fit.** `useFittedTabs` (`components/layout/useFittedTabs.ts`) is `TabStrip`'s measured-fit for Radix `TabsTrigger` strips, with `TabOverflowMenu` (`components/layout/TabOverflowMenu.tsx`) as the `+N` menu; the request builder's `RequestTabs` and the response viewer's `ResponseViewer` use them instead of scrolling (#2200). The widths come from `tab-fit.ts` (`naturalTriggerWidth`, `MARK_ALLOWANCE`, and `fitTabs`' `reserved` option, whose default is this strip's New-tab button), and the hook measures a wrapper around the `TabsList`, never the list. A hidden tab keeps its marks: `TabOverflowMenu` takes an optional `mark` node per tab, drawn after the label in its item, and an `attention` flag that puts a `TabErrorDot` on the `+N` trigger and names the tab in its `aria-label` ("3 more tabs, Console has an error"), so a failure is not lost to the menu.
- **The tablist holds tabs and nothing else.** The overflow "+N" trigger and the "+" button are siblings of the `role="tablist"` element, not children: inside it they are announced as part of the tab set. Each tab carries `id`/`aria-controls` (`tabElementId`, `tabPanelElementId`), and `Shell` gives the content region the matching `role="tabpanel"` + `aria-labelledby` - the WAI-ARIA relationship in both directions.
- **Right-click opens a menu of its own** (`tab-actions.ts`, issue #1360): Close, Close Others, Close to the Right, Close Saved, plus Copy Path for a loaded request tab (the collection chain and the request name, from `useTabDescriptors`) and **Copy for agent** for every tab that names an entity (request, collection, run, inbox, mock server; #2047). The line is the descriptor's `agentReference`, built in `useTabDescriptors` for the reason `path` is: a request tab's from the request's own name, never the URL-derived title; a run tab's from the loaded run through `lib/run-reference-input.ts`, since `GET /runs/:id` carries a `configSnapshot` and no `summary`; an inbox or mock-server tab's from the record `lib/shown-service.ts` says the tab shows, the lowest port when the tab has no address. Each is absent until its entity has loaded, and the welcome, settings, variables and dashboard tabs have none. No Duplicate - the store allows one tab per entity, so a second tab on the same request is not a menu item withheld here, it is a shape `openTab` refuses; duplicating the *request* is a different action under the same word, and it stays on the request's own row (decided in #1389, not deferred). The keyboard path needs no handler of its own: the platform's own contextmenu event (Menu key / Shift+F10) reaches the same `RowContextMenu`. Close Others, Close to the Right and Close Saved are store actions (`closeOtherTabs` / `closeTabsToRight` / `closeSavedTabs`), not a loop of single closes - see [tabs-store](state-management.md#tabs-storets---open-tabs--navigation). The same three are commands in `lib/commands/registry.ts`, so the palette reaches them too; they take the *active* tab where the menu takes the one under the pointer, and neither carries a chord - a keystroke that closes a strip full of tabs is one slip from losing the lot.

### `Shell` (`components/layout/Shell.tsx`)

Main layout: tab-centric with an activity rail, resizable drawer, split/overlay context bar with its own rail, and a docked footer (status in the centre, per-tab view controls on the right).

- **One uniform layout for every tab** - `ActivityRail` + `Drawer` (left) + a content column holding `TabStrip` over main + `ContextBar` + `ContextRail`. No tab type takes over the row. This is deliberate: the rail's view switchers always have a Drawer to act on, so they can never be dead. (Settings used to full-take-over and suppress the Drawer, which left those buttons doing nothing while Settings was open.)
- **Left navigation is always the Drawer.** Every main view that needs a category/entity list uses the shared Drawer for it - never its own left rail. `SettingsMain` and `VariablesMain` are pure content panes; their category trees live in the Drawer (`settings` / `variables` views). Follow this pattern for any new view - do not add a second sidebar inside the main area.
- **Keyboard handlers:** ⌘N (new request), ⌘S (save), ⌘W (close tab), ⌘B (toggle drawer), ⌘L (focus the URL bar), ⇧⌘E/H/U/S/T (drawer views), ⇧⌘] / ⇧⌘[ (next/previous tab), ⌘I (toggle context bar), ⇧⌘B (toggle the response position - beside or below the request - on a request tab only, #1711), ⌘, (open settings tab), F6 / ⇧F6 (next/previous region), and the navigation pair - ⌘[ / ⌘] on macOS, Alt+← / Alt+→ elsewhere (back/forward through the tab history, #1245). Every one of them is a `Chord` in `constants/shortcuts.ts`, matched by `matchesChord` - the same registry the `ActivityRail`'s tooltips advertise from, so no surface can claim a chord the handler does not listen for. They were fourteen hand-rolled comparisons until #938, which is how AltGr (Ctrl+Alt on European Windows layouts) came to fire Save and close tabs, and how ⌘1-9 came to be dead on AZERTY. F6 and ⇧F6 carry no ⌘ or Ctrl - the only chords here that do not - so a module-level `regionStep` helper matches them **before** the `if (!(e.metaKey || e.ctrlKey)) return` gate - as does `navigationStep`, for the same reason off macOS, where the navigation pair is Alt+← / Alt+→ (it declines a target that `ownsEnterKey`, so Monaco keeps the CtrlCmd+[ and +] it binds to outdent and indent) that keeps this listener off the typing path for everything else, still behind the `isModalOpen()` check every chord here shares. Off macOS the navigation pair is Alt+Arrow, the same chord the collection tree uses to reorder a row and the tab strip uses to move the focused tab, so neither widget's handler lets the event reach this listener: each calls `stopPropagation` while its own row or tab holds focus. Go back and Forward stay reachable from every other focus, the title-bar buttons, the palette and mouse buttons 3 and 4. ⌘K (command palette) is **not** in this map - it is owned by `CommandPalette`, on the capture phase, because Monaco swallows the key on the bubble. ⌘I is in the map and still needs help reaching it: Monaco claims CtrlCmd+I for `triggerSuggest`, so the bridge in `lib/editor-chords.ts` re-dispatches it from inside an editor (see [`code-editor`](#code-editor)), as it does the two send chords and, now, ⌘L - Monaco binds CtrlCmd+L to `expandLineSelection` the same way it claims CtrlCmd+I.
- **Region cycling (F6 / ⇧F6).** `cycleRegionFocus` (`region-focus.ts`) walks the shell's regions in document order - the five bands carrying `data-app-region` (`TitleBar`'s `<header>`, `ActivityRail`'s `<nav>`, `Drawer`'s `<aside>`, `Shell`'s own `<main>`, `ContextBar`'s `<aside>`), each spreading `regionProps("<band>")` from that file rather than writing the attribute itself, so the name it queries is spelled in one place - skipping any with nothing focusable and never re-entering the region focus is already in. A closed band (the drawer, the context bar) is simply absent from the DOM, so the cycle needs no knowledge of visibility. `ActivityRail` is always present, unlike the drawer and context bar, so it is never one of the bands the cycle has to skip. It lands focus on the region's first focusable element, found through `lib/focusable.ts` - the same `focusableWithin`/`focusFirstOf` pair `lib/editor-chords.ts` uses for the Monaco Tab-trap exit - rather than on the region container itself, which under the app's `:focus-visible` rule paints no ring for a `tabindex="-1"` element and would move focus with nothing on screen saying where it went. ⌘L is the same idea aimed at one field: `focusRequestUrl` (also `region-focus.ts`) finds the URL input by id - `REQUEST_URL_INPUT_ID`, declared in `constants/dom-ids.ts` since the Shell has no ref into the request builder that mounts the field - and does nothing when no request tab is open.
- **Drawer:** toggles visibility via `toggleDrawer()` (state in `useLayoutStore`); always resizable 220–480px.
- **Content routing:** switches main area based on `activeTab.type` (welcome | request | collection | dashboard | run | variables | settings | inbox | mock-server). Default is `WelcomeScreen`.
- **Every surface but `RequestBuilder` is `React.lazy`** (#1146), behind one Suspense boundary inside the tab panel whose fallback is a `DetailSkeleton` naming the pane. Only one surface is mounted at a time, so a boundary per branch would be the same fallback written eight times. `RequestBuilder` stays eager because it is what most sessions open into. Two consequences worth knowing: a surface must be imported from its own file rather than its module barrel (`@/modules/settings` also exports the Drawer's `SettingsCategoryTree`, so importing the barrel here would put the settings surface back in the entry chunk), and a lazy branch is still one component per tab type - the boundary does not remount tab content, which `shell-tab-identity.test.tsx` holds.
- **Drawer-view sync:** an effect points the Drawer at the view matching the active tab - `variables`→variables, `settings`→settings, `request`/`collection`→collections - and opens it. It fires on a change of tab type; switching between two tabs of the same type leaves the drawer's open state alone, so a drawer the user closed stays closed (#1863).
- **ContextBar mode:** picks "push" (≥1200px width) or "overlay" based on window width. It renders on the tab types the section registry has entries for - request, collection and run - and nothing on the other four. `relative` sits on the main+context row rather than on the outer one, so the overlay stops at the tab strip instead of covering the tabs it belongs to. `ContextRail` is a sibling of that `relative` row, not a child of it, so an overlaying `ContextBar` covers `main` up to the rail and never the rail itself (#1615).
- **The content region is the strip's tab panel.** A `role="tabpanel"` div inside `main` (not on `main`, which is a landmark and carries only `role="main"`), carrying the active tab's panel id and naming that tab with `aria-labelledby`. → `shell-tab-identity.test.tsx`.
- **The restructure must not remount tab content.** Drawer state is upstream of the column the active tab renders into, so a `key` derived from it - or a wrapper mounted only while the drawer is closed - throws away an unsaved body, a scroll position, a Monaco model. → `shell-tab-identity.test.tsx`.
- **`<ImportModal />`** and **`<CommandPalette />`** mounted once each as global overlays; visibility in a store rather than in the Shell.

### `Drawer` (`components/layout/Drawer.tsx`)

Resizable sidebar (220–480px, one width shared by every view - `layout-store` collapsed the per-view widths in v3). The single left navigation for the whole app - one of six views per `useLayoutStore.drawerView`. Every view is titled: its `DrawerPanel` header is the drawer's half of the second chrome row, sharing `--tabstrip-height` and its bottom rule with the tab strip across the resize handle, with an optional tools slot beside the title.

| View | Component | Band tools today |
|------|-----------|------------------|
| **`collections`** | `CollectionTree` (hierarchical collections + requests) | add collection, add request, import |
| **`history`** | `HistoryList` (past runs, filtered/sorted) | run count |
| **`variables`** | `VariablesCategoryTree` (globals, environments, collections) | - |
| **`services`** | `ServicesPanel` (webhook inboxes, OAuth issuers, mock servers) | new inbox, new issuer |
| **`trash`** | `TrashList` (deleted collections and requests, restore or purge for good) | item count |
| **`settings`** | `SettingsCategoryTree` (app + engine setting categories) | - |

Both `variables` and `settings` follow the same nav/content split: the tree lives here in the Drawer, the editor is the corresponding tab (`VariablesMain` / `SettingsMain`), and selecting a category sets the shared store selection **and** opens/focuses that tab.

A `TrashList` row is a `data-trash-id` box carrying `tabIndex={-1}` and `.focus-row`: not a tab stop in front of its buttons, but a target focus can be *put* on - which is what a permanent delete needs, since its confirm dialog has no trigger for Radix to restore to and the row it was opened from is about to go. Where focus lands follows the outcome rather than the confirm click, through the shared `useRemovalRefocus` (`hooks/useRemovalRefocus.ts`, also the collection tree's): the purged row while it is still there, and the next row - or the previous one, when the purged row was last - once it has actually gone (#1234). Purging the only entry leaves neither, and Trash has no create control to fall back on, so focus goes to the `data-trash-list` container itself, which stays mounted holding the empty state (#1279). The variables sidebar's environment rows delete the same way, through the trees' `useDeleteRefocus`.

Resize handle on the right edge (double-click resets to defaults). Visibility toggled by `toggleDrawer()` or ⌘B.

### `ContextBar` (`components/layout/ContextBar.tsx`)

252px panel showing a stack of collapsible sections about the active tab. It owns the frame - landmark, resize handle, header, scroll container, per-section collapse state - and nothing about what any section shows.

- **Push mode** (≥1200px): adjacent to main content, takes layout space.
- **Overlay mode** (<1200px): floats over main content, top-right (absolute positioned, shadow, z-10).
- **Toggle:** ⌘I, or any `ContextRail` icon. Visibility in `useLayoutStore`. `ContextRail`'s own visibility is "the active tab has content for the bar" (`contextBarHasContent`, shared with the bar itself) - previously the Dock's toggle button was pressed on `contextBarOpen` **and** that predicate, since a lone open flag lit it up on tab types the bar renders nothing for; the rail's per-section buttons now carry that same "open and expanded" logic individually. That predicate reads only `appliesTo`, never a section's `useRelevance`, and stays that way on purpose: it has to answer while the bar is closed, and a relevance hook run then would issue queries for a bar nobody opened.
- **Structure:** an `<aside>` landmark ("Context sidebar"), like the Drawer facing it. The resize handle and the header are direct children; the scroll lives on an inner wrapper (`data-context-bar-scroller`, the target `ContextRail`'s `scrollWithin` call scrolls), so the drag strip and the close button stay put while the sections scroll. Each section is wrapped in a `data-context-bar-section="<id>"` div - the anchor the rail scrolls to - since a section hidden by its own `useRelevance` renders nothing for `scrollWithin` to find otherwise. The left edge is the handle's own 1px hairline - the panel draws no `border-l` of its own.

### `ContextRail` (`components/layout/ContextRail.tsx`)

The right-edge counterpart to `ActivityRail`: one `RailButton` (`"tile"` variant) per entry `sectionsForTab(activeTab)` returns, so it renders nothing on a tab the bar has nothing for - the same `contextBarHasContent` predicate the bar itself and the old Dock toggle used. Clicking a section's icon opens the bar if closed, expands the section if collapsed, and scrolls it into view with `scrollWithin` (`@/lib/scroll-within`, #1612) - deferred to a `requestAnimationFrame` inside the click handler rather than called synchronously, since the target may not exist (or may still be collapsed) until React commits the open/expand state the same handler just requested; `requestAnimationFrame` runs after that commit's paint, not before it, which a `useEffect` keyed on the pending id would (correctly, but redundantly) achieve by calling `setState` from inside an effect body - `react-hooks/set-state-in-effect` is why this is a plain callback instead. Clicking the icon of the section that is the *only* one currently expanded collapses the whole bar instead - this rail's answer to a dedicated close button. The rail is one roving Tab stop, not one per section: `useRovingStop` holds it on the first expanded section (the first section when all are collapsed), and Up/Down move focus without toggling, wrapping at the ends - the model `ActivityRail` uses. → `ContextRail.test.tsx`. Present in both of `ContextBar`'s layout modes, including overlay (<1200px): it is a flex sibling of the `relative` box the bar overlays from, not a child of it, so the rail is never covered by the bar it fronts.

#### The section registry (`components/layout/context-bar/registry.ts`)

`CONTEXT_BAR_SECTIONS` is one ordered list of `{ id, title, icon, appliesTo(tab), useRelevance?(tab), Component }`. `sectionsForTab(tab)` filters it on `appliesTo`, and `contextBarHasContent(tab)` is `sectionsForTab(tab).length > 0` - so the bar's visibility and `ContextRail`'s own visibility read the same list and cannot drift. Adding a section for another tab type is one entry here and nothing else - `icon` is what `ContextRail` draws, so a section with none would leave the rail silently short a button rather than failing near the registry (`registry.test.tsx` asserts every entry carries one). `appliesTo` stays a pure, synchronous function of the tab alone and never a query: `contextBarHasContent` is called on every render of `ContextRail` and the old Dock toggle alike, including while the bar is closed, and a predicate that read a query could not be called from there at all.

`useRelevance` is the second, optional question a section can answer, asked only by the bar and only while it is open: how much this section has to say about *this* request, once its own data is in, rather than just this tab type. It answers `"content"` (draw as usual), `"hidden"` (draw nothing - the section structurally does not apply to this request, such as GraphQL off a non-GraphQL body or cookies before the URL has a host), or `{ empty: note }` (draw the header alone, with `note` after the title and no chevron, since there is nothing to expand). A section without one is `"content"` by definition, which is why the collection and run sections carry none. Before this, a plain REST request opened seven sections of which three existed only to say they did not apply ("This request does not send a GraphQL body", "No cookies held for this host", "This request has not been sent yet"), a header the reader scanned past on every tab (#1310).

**A section's component is mounted only while its section is expanded** (`context-bar/Section.tsx`), which is most of the cost model: the bar is open on every tab that has sections, so a collapsed section must register no queries. The one exception is a section's own `useRelevance` hook, which runs whenever the bar is open, expanded or not - so the precise guarantee is "no section mounts, and no query beyond the one its relevance already needs"; every relevance hook reads a query its own section already reads. Collapse state persists per section id in `layout-store` (`contextBarCollapsedSections`, collapsed-by-exception), and `code` is the one section that ships collapsed by default (`CONTEXT_BAR_DEFAULT_COLLAPSED`): its query is a `POST /compose` round trip, so an expanded-by-default Code section would have composed a snippet on every request tab opened, whether or not anyone looked. It declares no `useRelevance` for the same reason - answering would mean composing to find out.

**Mounting late is not the same as loading late.** A registry entry is imported when the registry is, and the bar is on every tab - so the GraphQL section, the one entry that reaches the `graphql` package (~320KB of source, through `parseGraphQLBody` and the schema cache), is a `React.lazy` component and arrives when it first renders (#1146). `ContextBar` wraps each section in its own Suspense boundary with `SectionLoading` as the fallback, so a section still loading looks like a section still fetching and cannot blank the ones beside it. Every other section is app code and Radix, and stays eager; a new one only needs the lazy form if it drags a parser-sized dependency in with it. Since `useGraphQLRelevance` now hides the section outright off a non-GraphQL body, "renders" no longer means "every request tab": a REST tab never requests the chunk at all, where it used to arrive the moment the expanded section mounted just to say the request was not GraphQL (#1310).

Sections are leaf components over the existing query layer - no bar-wide shared state - each with its own loading and empty body (`SectionEmpty`, `SectionLoading`).

**Request tab**

| Section (`id`) | What it shows |
|---|---|
| Variables used (`variables`) | `VariablesSection.tsx` - the variables this request references, resolved or not, with the full in-scope set behind a disclosure and a quick editor over them (below). The `id` stays `variables` - it keys the collapsed state. Quiet (`{empty:"none"}`) only when the request references nothing *and* nothing else is in scope; a request that references none while the workspace defines some still gets the disclosure, so it stays `"content"`. |
| Auth (`auth`) | `AuthContextSection.tsx` - the effective auth mode and where it came from, via the shared `resolveAuthSource` walk, so it cannot disagree with what is sent. For OAuth 2.0 it embeds `TokenStatusRow` (the Auth tab's own control) for token state, fetch and clear. Declares no `useRelevance`, always `"content"`. |
| Cookies for this host (`cookies`) | `CookiesSection.tsx` - the active environment's jar filtered to the request's host, with a per-scope clear. Host filtering is an **approximation**, stated in the UI: libcurl applies the real domain/path/secure rules at transfer time. Hidden before the URL resolves to a host; quiet (`{empty:"none"}`) for a host with an empty jar. |
| Code (`code`) | `CodeSection.tsx` - copy-as-curl / copy-as-fetch (below), composed from the editor's draft as Send composes it. Declares no `useRelevance`: it is the one section whose answer costs a `POST /compose` round trip, so a hook that decided whether it had anything to say would have to compose to find out, on every request tab, for a section that is collapsed by default (see above). |
| GraphQL (`graphql`) | `GraphQLSection.tsx` - schema status, the age of the schema in hand, the endpoint, and an outline of the operations the stored document defines. It carries **no Refresh**: the one it had stood beside the Query header's whenever the body panel was on screen with the bar open, and could never stand without it, since the button was gated on a schema-cache field only `GraphQLBody` set, and only for a non-empty URL (#1224). Status belongs in the bar; *browsing* the schema does not - that is the explorer docked beside the query editor (below). `appliesTo` sees only the tab, which carries no body mode, so it still applies to every request tab; `useGraphQLRelevance` narrows that afterward and hides the section outright off a non-GraphQL body, rather than rendering to say the request is not GraphQL. Because that verdict answers from the same `useRequestQuery` data the section itself reads, a REST tab never requests the section's lazy ~320KB chunk (#1146) at all - it used to arrive the moment the expanded section mounted just to say so (#1310). The outline reads the **stored** request, since the bar sits outside `RequestBuilderProvider` and cannot see the editor's live buffer; autosave keeps the two within a second or two. Each outline row is a button that **scrolls the query editor to that operation** and focuses it, from a hidden Body tab too - the provider brings the tab forward first, because the editor is unmounted anywhere else and revealing into an editor nobody can see is the silent-failure alternative. The row sends the operation's *name*, not the line it drew, and `findOperationLine` resolves it against the live buffer; an operation renamed since the outline was drawn reaches the polite live region instead of scrolling to whatever now sits on that line. The channel is `lib/graphql/reveal-store.ts` (below). |
| Recent sends (`recent-sends`) | `RecentSendsSection.tsx` - the last five design runs of this request, newest first: status chip, latency and age, each row opening that run in a History tab. One `GET /runs` call and no report fetch - status and latency ride on each row as `resultSummary` (see below). A run with no stored result reads "Sending…" or "No result" rather than a status-0 chip, which the wire uses for "reached no server". Quiet (`{empty:"not sent yet"}`) when nothing has been sent - the list query behind the verdict is the section's own, the one page of `GET /runs` it would make on expansion anyway, so a collapsed section costs one list call and an expanded one costs nothing extra. |

**Collection tab**

| Section (`id`) | What it shows |
|---|---|
| Variables in this collection (`collection-variables`) | `CollectionVariablesSection.tsx` - the definitions this collection owns (not a resolved set), editable through the same commit path as the request tab's list. A disabled definition is shown and marked `off` rather than hidden. |
| Auth (`collection-auth`) | `CollectionAuthSection.tsx` - the mode this collection is set to, and what a descendant set to Inherit would pick up: the same `resolveAuthSource` walk, so a collection set to plain No Auth names the ancestor that answers instead. While the Auth tab is open and dirty, this reads the tab's unsaved pick (`useCollectionAuthDraft`, #1483) rather than the last-saved mode, so the two panes agree, and its sentences end "(unsaved)" while that pick differs from the stored auth (a request below still sends the stored row until Save). |
| Contents (`collection-contents`) | `CollectionContentsSection.tsx` - direct child counts (requests, sub-collections), matching what the tree shows under the folder. |
| Last run (`collection-last-run`) | `CollectionLastRunSection.tsx` - how this collection's most recent run went: the outcome word in its status colour, the plan's size (`3 steps`, `× 2` only when more than one pass ran), and the age, opening that run in a History tab. One `GET /runs?collectionId=&limit=1` call and no report fetch - the server's `start_time DESC` makes the single row the answer. A run still going reads "Running" rather than an outcome, and a run stored before the engine sent the `scenario` descriptor shows no size rather than "0 steps". |

**Run tab**

| Section (`id`) | What it shows |
|---|---|
| Run config (`run-config`) | `RunConfigSection.tsx` - mode, duration, target RPS, virtual users, iterations, ramp and requested protocol, read from the run's stored `configSnapshot`. Words come from `loadTestModeLabel` / `formatConcurrency` ("64 virtual users"; the one spelling of the unit is `constants/load-test-modes.ts`). A design run has no `mode` key and reads as "Single send". A **collection run** has none of those keys at all - it reads its `scenario` block instead (`run-scenario.ts`) and shows "Collection run", the plan's step count, iterations, whether sub-folders were included, and a **Data file** row naming the file the run's rows came from (issue #2051; the display name, never a path, read through `lib/run-data-file.ts`'s one reader of the name/hash pair). |
| Source (`run-source`) | `RunSourceSection.tsx` - the environment the run used (`Run.environmentId`, which nothing rendered before) and a link opening the request it ran from. A deleted environment is named as deleted rather than folded into "No environment"; a deleted request (`isRequestNotFound`, never a transport failure) drops the link. A **collection run** links no request - its source is the folder - so the row names the collection and opens *that* tab. |

`run-scenario.ts` is the one place the snapshot's `scenario` block is narrowed
(it arrives as `unknown` through `RunConfigSnapshot`'s index signature). It gates
on `run.type === "scenario"` as well as the key, so a load run whose raw body
happened to carry a `scenario` the engine ignored is never described as one.

The collection and run sections gate on `tab.entityId` as well as the type: a tab open on nothing renders no pane either, and a section there would query nothing while lighting `ContextRail` over an empty bar.

**`collection-last-run` was deferred twice before it landed** (specced in #377, deferred in PR #394 as "no runs exist until #354", re-deferred in PR #400 once the runner existed), each time for the same reason: a collection's runs were not addressable. `GET /runs` filtered by `requestId`, a collection run links none, and the only route to the row was a substring search of every stored snapshot for the collection id - a scan per open bar. #422 added `GET /runs?collectionId=`, which matches the scenario snapshot's own field as JSON rather than its text, and the section is one filtered query for exactly the row it shows.

**There is still deliberately no "last result" section**, and `recent-sends` is not one. Status, duration and age of the *last* send are what `ResponseStatusBar` already paints in the response pane on the same screen - same `StatusCodeBadge`, same stored run, since the builder restores that run into the pane whenever nothing is in memory. A section with no state in which it says something the pane does not say better is a duplicate, not a summary, which is why the specced one was built and removed in #344. What the pane structurally cannot show is *more than one send*, and that is the whole content of `recent-sends`: if it ever narrows to the latest run it is the removed section again. Its id is new rather than reused, so the `last-result` guard in `registry.test.tsx` keeps guarding.

That section is affordable because the paginated `GET /runs` now carries each design run's outcome on its row (`resultSummary`: `statusCode` + `latencyMs`), added for it in #380. Before that, N rows meant N `GET /runs/:id/report` calls, and that path loads and JSON-parses every result's `trace_data`. Collection runs carry no `resultSummary`, and a load run's (`{rps, p95Ms, errorRate, verdict}`, #2130) comes from its stored summary rather than its results - those are unbounded, and the engine's design-result query cannot read them even if asked.

**Freshness is wiring, not polling.** `runs.recentDesign(requestId)` is its own key family (like `runs.lastDesign`, and for the same `InfiniteData` shape-clash reason), so nothing under `runs.lists()` refreshes it: the builder's send path, the run view's replay, the MCP `run` event and the delete/clear-history paths each invalidate it explicitly. A new invalidation point for runs needs to touch it too, or the section silently shows the sends from before.

#### Variables section

Leads with the variables **this request references** (#1308), not every name in scope: the section walks the stored request's templated fields (`lib/request-references.ts` `referencedVariableNames` - URL, params, headers, body and form parts including a file part's `src`/`fileName`/`contentType`, the auth it sends with `inherit` walked, and a script's `pm.*.get()` names) and splits the result into the references that resolve - each a row with the name (`TruncatedText`), its winning scope (`VariableScopeBadge`) and value (secrets masked) - and the references nothing defines, marked `not defined` in the editor's destructive tone with no input. Everything else in scope sits behind a collapsed `All in scope (N)` disclosure, so the quick-edit-anything path is not lost. A request that references none says `This request uses no variables` above that disclosure; only a request with nothing referenced and nothing in scope says `No variables in scope`. Value inputs are named `Value of <name>`. The reference set is read from the **stored** request via `useRequestQuery`, so it lags the live editor buffer by the autosave interval, the same lag the GraphQL outline documents - the bar sits outside `RequestBuilderProvider` by design.

**Editing:** a blur (or Enter) commits the value back to the definition the resolver picked - looked up by `ResolvedVariable.sourceId`, not re-derived (see [variable resolution](./variable-resolution.md#getvariableoriginsname)). The payload is read from the query cache at commit time and patched into it optimistically, so a second blur before the first mutation settles cannot re-send the first one's old value. Commits register with the save store, so a quit flush waits for one in flight.

The row and the commit are shared, not per section: `VariableRow.tsx` draws it (the remount key, the Escape restore, the uncontrolled input a rejected save depends on) and `variable-commit.ts`'s `useVariableCommit` writes it, so the collection tab's list gets the same fixes. Its rows are the collection's own definitions with that collection named as the source, which lands in the same place a collection-scope edit from the request tab does. A secret row draws the shared `SecretInput` primitive (#1308) - masked, read-only, with a keyboard-reachable eye that reveals the value in place rather than the old `••••••` that could never be looked at; reveal state is keyed by the definition's identity (name:scope:source), so an environment or tab switch re-masks. The collection tab reuses `VariableRow`, so it gets the reveal for free.

#### Code section and `services/codegen/`

Snippets are generated from **`POST /compose`'s output** - the request with `{{variables}}` substituted and `inherit` auth walked by the engine that will send it - so what you paste is what Vayu would put on the wire. **What is composed is the editor's draft, not the saved row** (#2638): the bar sits outside `RequestBuilderProvider`, so the builder publishes its draft and collection chain through the `editorDraft` live surface (`EditorDraftSurface.tsx`, see [the command registry](#command-registry-libcommands) below), and `code-composition.ts` builds the inline body with `buildComposeBody` from the inputs Send gives it - the same request, unsaved edits included, and the `stream` flag and jar note read from the draft too. With no builder holding the request (one still mounting) it composes the stored row by id and says under the snippet that it is the saved request's, since that trails the editor. A **Templated** mode generates from the stored request instead, references intact, for pasting into a bug report; it stays on the stored row (there is no `RequestState` to `Request` mapping to feed it the draft without a second field list) and carries the same saved-request note. Composing happens on every expand (an editor-held snippet recomposes on mount, so a collapse, edit, re-expand is current), on an explicit recompose, when a builder takes the request on, and on a committed write's invalidation (the autosave PUT included, which re-reads the draft), never per keystroke (the section only mounts while expanded, and the query is `staleTime: Infinity`).

`services/codegen/` holds the generators, closing the symmetry with `services/curl/`, which parses curl *in* and generated nothing out. Each target is a pure function of a `SnippetRequest`; `CODE_TARGETS` is the registry, and adding a target is one entry plus one function. Auth is flattened into headers/query/`-u` in `prepare.ts` rather than per target, because the engine keeps `auth` beside the request and applies it at send time: a snippet built from the composed *headers* alone would authenticate in Vayu and 401 in a terminal. Modes no static command can reproduce produce a note instead of a silent drop: OAuth 2.0 (the engine fetches the token at send time) and the modes Vayu does not send at all (digest, AWS, NTLM, Hawk, OAuth 1.0, EdgeGrid, JWT bearer), which the note names with their registry label and says Vayu does not send, so the snippet matches the request Vayu sends without auth (issue #2474). `prepare.ts` skips an auth header the request already carries (bearer or basic over a typed `Authorization`, an API-key header over a typed header of that name, matched case-insensitively and leaving `basicAuth` empty so `-u`, `-a`, `auth=` and `btoa` stay unused), as the engine's `apply_auth` does, so a snippet never sends two lines where Vayu sends one (issue #2475; pinned by `engine/tests/fixtures/auth-header-precedence.json`). The fetch and Python targets add a note when a header value (an auth-derived one included) holds a character above U+00FF, which those clients cannot send, or one in U+0080 to U+00FF, which they send as Latin-1 where Vayu sends UTF-8; the value is never transcoded, and curl carries no such note. `prepare.ts`'s implied Content-Type table mirrors the engine's exactly - `json`, GraphQL and JSON-RPC as `application/json`, XML as `application/xml` - so a snippet of a json-mode body carries the header the engine would add, and pasting it back through `parseCurl` reads it as json rather than text (issue #1445). `SnippetRequest.params` carries a request's path rows (issue #1764), and `prepare.ts` fills the URL's `:name` segments from them with `substitutePathVariables` - the engine's rule: the last enabled row with the key answers, and its value is percent-encoded with Postman's path encode set (`postman-url-encoder`'s `PATH_ENCODE_SET`: controls, non-ASCII, space, `"`, `<`, `>`, `` ` ``, `#`, `?`, `{`, `}`; a `/` makes more segments, `@ : % !'()*` and the rest go out as typed, and a `{{variable}}` token is kept verbatim); an empty value or no enabled row leaves `:name` literal, and a `.suffix` after the name stays. The templated view and the builder's Copy as cURL pass the rows; the resolved view's composed URL is already substituted. `prepare.ts` then runs `resolveUrlTemplate` over the substituted URL with the `{{token}}`s left in place (issue #2465), so the snippet carries the line Vayu sends - the literal text around a token encoded by its component's set, a head backslash a `/`, the host lowercased and punycoded - and under `disableUrlEncoding` the URL as typed. A request with `disableUrlEncoding` (issue #1765) passes the flag on `SnippetRequest`, and `prepare.ts` then substitutes each value as typed - no path encode set at all, as Postman's `toNodeUrl (url, disableEncoding)` skips `encodePath` - and appends a query-located API key raw, as the engine does; otherwise that key and value are written with Postman's query rule (`encodeQueryComponent`, issue #1771: `|`, `+` and `=` in a value go out raw), the engine's `append_query_param`; the Code section's jar note says the jar is off for a request with `disableCookies`, since the snippet is then the whole request. `followRedirects` is the same split curl's own default forces the other way from `verifySSL`: curl does not follow unless told to, so `-L` is emitted for the common (following) case rather than only the departure from it.

**Quoting is per target, never a flag on another one** - that is why PowerShell is its own generator rather than "curl with different quotes". Each language's escape rule and its form-body switch differ in ways that fail silently:

| Target | String rule | Multipart vs urlencoded |
|---|---|---|
| `curl` | POSIX single quotes, `'` → `'\''` | `--form-string` (or `-F` for a typed text part) vs `--data-urlencode` |
| `fetch` | `JSON.stringify` (it *is* the JS literal grammar) | `FormData` vs `URLSearchParams` |
| `python` | `JSON.stringify` - JSON's escapes are a strict subset of Python 3's | `files=` vs `data=` (a multipart body passed as `data=` is silently urlencoded) |
| `httpie` | POSIX, shared with curl | `--multipart` vs `--form` (`--form` alone is urlencoded) |
| `powershell` | Single quotes, `'` → `''`; a POSIX `'\''` would put a backslash in the data | `-Form` vs `-Body` |

A repeated header (issue #2466) stays one flag or word per line: curl writes `-H` once per line and HTTPie one `Name:value` word per line, while `fetch`, `requests` and `Invoke-RestMethod`, whose header map holds one value per name, get the lines joined into one entry (`foldRepeatedHeaders`: `", "`, `"; "` for `Cookie`) and a note that Vayu sends them as separate lines. HTTPie takes headers as bare `Name:value` words and a body as `--raw`, so the composed bytes go out unchanged rather than HTTPie building a new JSON object from `key=value`. PowerShell emits `Invoke-RestMethod`, not `curl` - on Windows PowerShell `curl` is an alias for that cmdlet, so a snippet saying `curl` runs something else than the reader expects, and a multipart snippet carries a `# requires PowerShell 6.1+ (-Form)` line because 5.1 has no `-Form` at all.

**Quoting is not the end of it: a client can read its own argument as a path.** The bytes survive the shell and the *client* then interprets them, so curl's `-F` uploads a local file for any value starting with `@` or `<`, and HTTPie's item grammar reads `=@` the same way (plus `==` as a query parameter, and a `:` or `@` in a key as a header or a file upload). curl form fields therefore use `--form-string`, which has no such grammar, and HTTPie items escape with a backslash on the key and on a leading separator in the value. `--data-urlencode` encodes only what follows the first `=`, so the field *name* is percent-encoded here and the value is left to curl.

**A text part that declares its own Content-Type** (a Postman import keeps one, #2539) is sent with it, so the snippets carry it where the client can: curl needs `-F` for the `;type=` modifier, which `--form-string` cannot take, and writes the value double-quoted (`-F 'k="v";type=application/json'`) because curl reads a quoted value as text whatever it starts with, where a bare `@` or `<` would be a file; Python gives it requests' filename-less tuple `(None, value, type)`. HTTPie, `fetch` and PowerShell have no spelling for a text part's type (`FormData` would add a filename), so they send the part untyped and a note names it (`untypedTextPartNote` in `prepare.ts`). `parseCurl` reads the same `;type=` back from a text `-F`, so the curl snippet round-trips.

**Secrets are masked by default in resolved output**, revealing is explicit, and masking happens *before* quoting - after it, a value containing a quote no longer matches itself. What is masked: every variable the resolver marks secret (and its URL-encoded forms - the query encoding the engine writes, the URL-text form a `{{token}}` takes substituted into the path, query or fragment, each by its own encode set (`&` and `=` left raw; in the host, the value as typed and as the composed URL writes it, lowercased and punycoded (`encodeHost`; a secret that is only part of a label is rewritten with the whole label by punycode and is not matched, #2591)), and `encodeURIComponent` - because a value substituted into a path or query reaches the payload encoded), the credential the auth mode carries, and the value of any header row whose *name* is sensitive, whether or not a secret variable holds it (`lib/sensitive-headers.ts`: `authorization`, `proxy-authorization`, `cookie`, `set-cookie`, `x-api-key`, `x-auth-token`, `x-csrf-token`, plus the header the request's API-key auth names; pinned to the engine's redaction list by the `sensitiveHeaderNames` key of `log-redaction-conformance.json`). One list builder, `collectSecrets`, and one masker, `createSecretMasker` (`prepare.ts`), so a second surface showing the resolved request hides exactly what the snippet does. Jar cookies are never in a snippet (libcurl attaches them at transfer time) and the section says so.

### `ActivityRail` (`components/layout/ActivityRail.tsx`)

The app's primary navigation, on the window's left edge rather than its bottom (#1615): on macOS with Dock auto-hide on, the pointer crossing the screen's bottom 60-80px summons the system Dock over whatever sits there, and the switchers used to sit exactly there.

- **Six buttons** for Collections (⇧⌘E), History (⇧⌘H), Variables (⇧⌘U), Services (⇧⌘S), Trash (⇧⌘T), Settings (⌘,) - the order, labels and icons come from `constants/drawer-views.ts`, the table the command palette's five `show-<view>` commands are generated from too, so the rail and the palette cannot disagree about what a view is called or draw it with a different icon. A descriptor may carry a one-line `hint` (Services only: "Webhook inbox, OAuth issuer, mock servers"), which `RailButton` draws as a second `TooltipHint` line under the label and chord and never puts in the accessible name; the rule for when a view earns one is in `docs/ux-writing.md`. Top-aligned as one cluster, not pinned to the rail's bottom - a bottom cluster reintroduces the Dock's own problem in miniature. Each activates its Drawer view; the active one is marked by a 2px accent bar on the rail's outer edge (`RailButton`'s `"edge-left"` variant), not a filled tile, since this is one mutually-exclusive choice rather than a row of independent actions. A small `status-success-text` dot on the Services button lights up whenever `useRunningServiceCount()` is nonzero - the one badge the footer carried that moved here; the Dock keeps its own worded count (below).
- **Roving `tabindex`, `role="toolbar"`-free** - the same choice the Dock nav this replaces made, restated: that role promises full toolbar semantics beyond arrow-key traversal, and six toggle buttons in a `<nav>` are not a toolbar. `ArrowUp`/`ArrowDown` move focus without activating, mirroring `TabStrip`'s own arrow-key handler (the stop is `useRovingStop` state fed to each button's `tabIndex`, then the destination is focused; #1856) - the roving stop starts on the *selected* Drawer view, not whether the Drawer is currently open, so a closed Drawer never leaves the rail with zero tab stops, and a later view change takes it back from wherever the arrows left it.
- **A fifth stop in the F6 region cycle** (`"rail"` in `region-focus.ts`'s `AppRegion`), so a keyboard user reaches the app's primary navigation even with the Drawer collapsed.

### `ContextRail` - see the `ContextBar` section above.

### `Dock` (`components/layout/Dock.tsx`)

Footer bar (`--dock-height`, shrink-0): status in the centre, per-tab view controls on the right. #1615 moved its two switchers onto the rails above and left it status-only; #1711 amends that to admit a right-aligned cluster that acts on the *active tab's* view, rendered only while that tab is a request tab. Every item here has a non-footer path (the response position has its chord, its palette row and its Settings row), so the system Dock covering this strip on macOS costs a glance, never a click.

- **Engine connection status:** green dot + "Connected" once `engineStatus` is `connected` (a tooltip too: it names the engine's address, which is a fallback port when another program held 9876, issue #2118); a dim "Starting…" while it is `starting`, since the window paints before the engine answers and that is not yet a failure. Only `unreachable` turns the indicator into a focusable tooltip carrying `engineError` - the health poll's reason, which was previously recorded and rendered nowhere, so a refused connection, a timeout and a TLS failure all read as one word. When the main process reports a start failure (`engineStartFailure`, every engine port held) its sentence replaces `engineError` there and a Retry button appears beside the light, the same `EngineRestartButton` the pending-restart control uses. The version string is itself a focusable tooltip once the first health poll answers, carrying the `workers` count (issue #1508) - the `workers` setting's effective value, which `GET /health` had always reported and nothing in the app had ever read.
- **Running services:** a dot plus "2 services" whenever at least one local service (a running webhook inbox, an OAuth issuer) is up, and **nothing at all when none is** - the Dock's middle is ambient, and a standing "0 services" would spend a permanent line on the ordinary case. An engine that is not `connected` - starting or unreachable alike - **counts as none**, whatever the query cache still holds: services are engine-*process* state, so they died with it, and the gate lives in `useRunningServiceCount` rather than here so no later reader has to re-derive the caveat. Clicking it **reveals** the Services drawer (`revealDrawerView`, never `activateDrawerView`) - an ambient chip pointing at a surface must not be the thing that hides it, and on the toggling call it closed the drawer whenever it was already on Services. → `Dock.services.test.tsx` (mutation-checked: rendered unconditionally, the absent-case tests fail; on `activateDrawerView`, the reveal case fails).
- **Pending restart:** once a setting the engine marks `requiresRestart` has been saved, a "Restart pending" button appears beside the connection status and restarts the engine in place (`useEngineRestart`, shared with the Settings banner so the two cannot diverge). It tracks saves made since this renderer connected - not a comparison against the engine's running values, which it does not report - so it says *saved*, not *in effect*, and does not survive a renderer reload. A failed restart leaves the signal standing and reports the reason as a toast.
- **Save status:** Saving… / Saved / "Not saved" (a toast carries the failure reason first; this line is what outlives the toast, per `app/CLAUDE.md`'s save-retry rule).
- **Response position** (`ResponsePositionButton.tsx`, request tabs only): one icon button that moves the response pane from beside the request to below it and back, its icon naming the destination (`PanelBottom` while beside, tooltip "Response below"; `PanelRight` while below, "Response beside"), swapped with `IconSwap`, ⇧⌘B in the tooltip. In Auto it shows Auto's current pick and a click writes an explicit Beside or Below. Right-click opens a radio menu over Beside / Below / Auto (`ContextMenuRadioGroup`, marked `own-menu` so the main process's edit menu stays away), the one way back to Auto from the strip. Same store action as the chord, the palette row and Settings > Appearance > Response position (`toggleResponsePosition` / `setResponsePosition` in `layout-store`). → `Dock.response-position.test.tsx` (mutation-checked: without the request-tab gate, the absence cases fail).

### Right-click menu (`electron/context-menu.ts`, `lib/context-menu.ts`)

Electron draws no context menu of its own. `electron/context-menu.ts` composes one in the main process from Chromium's `context-menu` params (`isEditable`, `selectionText`, `linkURL`, `editFlags`) plus a target the renderer announces on the way past - a capture-phase `contextmenu` listener installed once by `useMenuActions` (mounted in `App`), through `installContextMenuBridge` in `lib/context-menu.ts` (issue #1359).

| Under the pointer | Menu items |
|---|---|
| An editable field | Cut / Copy / Paste (enabled per `editFlags`), a separator, Select All - all Electron roles, so the OS supplies the accelerator |
| The URL bar | The above, plus "Paste as curl" / "Paste as wget" when the clipboard holds one - imports through `UrlInput`'s existing paste import |
| A `{{token}}` | The above, plus "Edit variable" - clicks the token, the popover's own way in |
| A link (http/https only) | "Copy Link" and "Open in Browser" |
| Read-only text with a selection | Copy |
| A Monaco editor | Nothing - it draws its own menu |
| A row or a tab | Nothing - the row or tab draws its own |
| Anything else | No menu |

The renderer marks what a surface means with `data-context` ("url-bar" | "monaco" | "own-menu", spread from `contextProps`) and `data-context-variable` (spread from `variableProps` on the token in `EditableVariable`); the main process reads only those markers plus what Chromium's params already say, since it has no way to read the DOM itself. `own-menu` is answered exactly as `monaco` is, with an empty template, and it is the only refusal that reaches the main process for a different reason than Monaco's: Chromium raises `context-menu` on the web contents whatever the page's own listener does with the DOM event, so a row's `preventDefault` never gets there, and the marker is what stands in for it (issue #1360).

### Row and tab actions menu (`components/shared/RowContextMenu.tsx`, `row-actions.ts`)

A row's actions are one list, drawn by two menus: `RowActionsMenu` (the `⋯` trigger, a `DropdownMenu`) and `RowContextMenu` (right-click, a Radix `ContextMenu` - a second family rather than the dropdown positioned at the pointer, since a context menu anchors to the click point and answers Shift+F10 on its own). Both render the same `RowAction[]`; `row-actions.ts` holds the one rule about the list (the first destructive action gets a separator above it) and `RowActionBody.tsx` holds what one item draws (icon then label, plus the `disabledReason` a gated item carries at its trailing edge - issue #1690, where a tooltip would fight the menu for the keyboard), so neither menu can drift from the other. Environment rows and history rows (`RunItem`) take `RowContextMenu`; the collection tree opens one menu for all its rows instead (`CollectionTreeContextMenu`, below), drawing it with the same `RowContextMenuContent`; history rows had no menu at all before it, since pin and delete were hover-revealed buttons only, and the handlers those buttons call now take an optional event for the same reason a menu selection is not a click on the card. **Every row that names an entity also carries "Copy for agent"** (#2047): the item's `hint` is the reference line from `lib/agent-reference.ts` and `onSelect` copies it through `useCopy()` as "Reference", placed before the destructive item. Duplicate uses the `CopyPlus` glyph so the two copy items differ at a glance.

`RowContextMenu` wraps rather than replaces the row (`asChild`), marks it `own-menu` so the main-process menu above stands down, and focuses the row on the way past so Escape returns focus there instead of `<body>`. It does not select the row - selecting would mean opening a tab, which no file manager does on right-click - each row's actions already close over that row's own entity. While a row is renaming or deleting, both the menu and the marker stand down together, so a right-click inside the open rename field gets the platform's own Cut/Copy/Paste rather than neither.

`TabStrip` uses the same `RowContextMenu` for its own right-click menu; see its entry below. The collection tree is the one surface that does not wrap each row (#2543): a thousand rows were a thousand Radix roots, so `CollectionTreeContextMenu` makes the `role="tree"` element the single trigger and keeps every behaviour above row for row - the row is resolved from the click, the row (not the menu) carries the `own-menu` marker so it still comes off with a rename, and a right-click with no row of ours under it is stopped before the trigger, so the platform keeps its default there.

## Request Builder (`modules/request-builder/`)

The request editor. Entry: `modules/request-builder/index.tsx`.

**Container (`index.tsx`)** - fetches the selected request (`useRequestQuery(selectedRequestId)`), maps the stored `Request` (discriminated-union `body`/`auth`) into flat UI state, and provides callbacks through `RequestBuilderProvider` to `RequestBuilderLayout`. Responsibilities:

- **Execute:** resolves `{{variables}}` in URL/headers/body, resolves auth, composes scripts, and calls the engine via `useEngine()`. It adds **no** headers of its own: since issue #1229 the engine adds `User-Agent`, a negotiated `Accept-Encoding` and an opt-in correlation id on every send path, and derives the `Content-Type` a body mode implies when none is declared (`text/plain` for `text`, none for a bodyless POST, issue #2464); the builder only passes on the names a send refuses (`disabledDefaultHeaders`, ticked in the Headers tab and never persisted).
- **Auth inheritance:** for `auth.mode === "inherit"` it walks the collection ancestor chain **leaf-first** (`useCollectionAncestors`) via the shared `resolveAuthSource`, taking the first collection that defines auth and stopping at one explicitly set to `noauth` (see [variable resolution → auth inheritance](./variable-resolution.md#auth-inheritance)).
- **Script composition:** concatenates ancestor collection pre/post scripts **root→leaf**, then the request's own script.
- **Load test:** opens `LoadTestConfigDialog`, then starts the run (`apiService.startLoadTest` + `loadTestService.startMonitoring`) and navigates to the dashboard.
- **Save:** `buildUpdatePayload` rebuilds the `RequestBody`/`RequestAuth` unions from flat UI state via `useUpdateRequestMutation`, and includes only the fields `RequestBuilderProvider` says the user touched (issue #1436) - an untouched field is omitted, which the engine's partial update reads as "leave it alone", rather than being resent unchanged. `name` keeps its own rule inside that: sent trimmed, and omitted even when touched if it is blank, so a partial update leaves the stored name alone rather than clobbering it - see [the draft adopts an external write per field](./state-management.md#the-request-builders-draft-adopts-an-external-write-per-field) for why sending it at all took a fix in the provider first.
- **A request deleted while its tab is open** (issue #1436) does not unmount the builder: `index.tsx` keeps `RequestBuilderProvider` mounted and swaps `RequestBuilderLayout` for `DeletedRequestBanner`, so the draft the user had is still reachable through context. The banner offers **Copy as curl** (built locally, from the draft alone - `inherit` auth resolves against no ancestors, since the collection may be gone too) and **Close tab**. A request that 404s on its *first* load, with no draft ever seeded, still gets the plain "no longer exists" pane - there is nothing to preserve.

**Structure:**

| Path | Role |
|---|---|
| `context/RequestBuilderProvider.tsx`, `context/RequestBuilderContext.tsx` | Local request-editing state + the execute/save/load-test callbacks. Also owns the per-field merge against an external write (issue #1436) - `fieldConflicts` / `takeExternalField` on the context, backed by `app/src/lib/field-merge.ts`'s `mergeExternalWrite` |
| `components/RequestBuilderLayout.tsx` | Resizable vertical layout composing TabBreadcrumb / UrlBar / ExternalChangeNotice / RequestTabs / ResponseViewer |
| `components/ExternalChangeNotice.tsx` | One [`ExternalChangeCallout`](#shared-external-change-callout-componentssharedexternalchangecallouttsx) per conflicted field group (issue #1436) - the four body-shaping fields collapse into one "body" callout, and "Take theirs" resolves every field in the group it names |
| `components/useRequestCrumbs.ts` | The builder's half of the crumb line: the collection chain root-first (`useCollectionAncestors`, cycle-guarded) then the request name, handed to the shared `TabBreadcrumb` (see its own section) which draws it. A collection segment opens that collection's tab; the name segment is inert, because renaming is the Info tab's job and a second surface would be two controls for one act |
| `components/UrlBar/` | `index`, `MethodSelector`, `UrlInput`, `SendWithRowDialog`. The method dropdown lives **inside** the URL field's border (one control, not two - it was a separate `w-[76px]` box sized for OPTIONS). Send + Load Test are one **attached** pair on the same accent: Send is `--primary-fill` with a white label, Load Test is `--primary` at 12% with `--primary-text` and a transparent left border, so the join is a step in weight rather than a seam between materials. Send owns both corners when it is alone - `canStartLoadTest` false **and** no row caret. `SendWithRowDialog` is that caret: a split-button on Send that opens the collection's data rows and sends bound to one (issue #601). It is **absent**, not disabled, unless a data contract is in scope *and* `data-file-store` remembers a file for the collection that declared it - and while a stream is open, where Send is Stop. The file is read when it opens, never on mount, and the rows are held no longer than the send. It was a ~384px popover until issue #892, which is where every compromise in it came from - a row was one truncated line with its column name printed in front of every value, the list stopped at twenty rows, and a number field stood in for the rest. It is now a `2xl` dialog: the columns are named once in a sticky header, every row is in the grid (arriving as they are scrolled to, via `useGrowingWindow`), a filter narrows them across all columns, and the number field is the shortcut to a distant row rather than the only route to it. Clicking a row still sends outright, because the one-click loop is the point of the feature; the footer's **Send row N** is for a row reached by typing or by arrow keys. The grid is `role="grid"` with a roving tabindex, so a thousand rows are one tab stop rather than a thousand - **exactly one**, falling back to the first rendered row when the selected row is off screen (a remembered index past the window, or one a filter excludes), since a grid with no tab stop is a grid the keyboard cannot reach at all (issue #936). Arrow, Home, End and PageUp/PageDown move the selection *and* DOM focus together, so a screen reader is told which row is now selected; the selection itself is still never clamped to make a send possible (issue #894). Both shortcuts (`⌘↵` / `⌘⇧↵`) come from `constants/shortcuts.ts` and are shown on the buttons. Pasting a curl/wget command into `UrlInput` auto-imports it (see note below); the empty field's placeholder and the first-run New request tile say so, and the Import dialog's Paste tab takes a command too, offering to open it as a new request (#2250), because Import is where a Postman user looks for curl (#2196). Typing into the field merges the parsed query into `params[]` rather than replacing it (`mergeParamsFromUrl`, `utils/url.ts`), each row holding the query as written, never decoded (`a%20b` stays `a%20b` in the table, as in Postman's; issue #1771) - a disabled param row is invisible in the query by design, so a wholesale replace deleted it on every keystroke, and clearing the query left the enabled rows it used to carry behind (issue #1482). The same merge keeps the **path rows** (`in: "path"`, issue #1764) in step with the URL's `:name` segments (`syncPathRows`, `utils/path-variables.ts`): a new segment adds a row with no value, a removed one drops its row, and an edited one renames its row and keeps the value, since every keystroke of retyping `:id` as `:userId` is a rename. The segment rule - a path segment after the authority that starts with `:`, its name running to the first `.` (`:id.json` is `id` with a kept `.json` suffix), a backslash counting as `/`, `{{variable}}` tokens opaque, never a port and never in the query or fragment - is stated once in that file and is the engine's `path_variable_segments` (`engine/src/core/path_template.cpp`), whose test cases `path-variables.test.ts` mirrors one for one |
| `components/RequestTabs/` | `index` + `panels/`: `InfoPanel` (**first in the row**), `ParamsPanel`, `HeadersPanel`, `BodyPanel`, `AuthPanel`, `AuthInheritBanner`, `ElementsPanel`, `InheritedElementsNotice`, `LegacyScriptNotice`, `ChainCard`, `ExamplesPanel`, `SettingsPanel`. Params, Headers, Auth, Examples and Settings still mount only while their tab is active - Radix's default. `BodyPanel` and `ElementsPanel` are the exception (issue #1718): each carries a Monaco editor (Elements one per `script.pre`/`script.post` row, issue #1643), and switching away and back used to tear the editor down and rebuild it, losing the cursor, the scroll position and the undo stack even though the text survived (it is read back from the request store). `index.tsx` now force-mounts a panel in `EDITOR_TABS` once the user's `activeTab` has visited it - a `visited` set in component state, seeded from the tab the request opens on and grown as the user switches - so a request opened on Params never pays for either editor, and once Body or Elements has actually been opened its panel (and every editor it mounted) stays alive, hidden via `components/ui/tabs.tsx`'s `data-[state=inactive]:hidden` rather than unmounted, for the rest of this builder instance. The memory trade this buys: `Shell.renderTabContent` mounts one workspace tab's surface at a time, so the ceiling is one live `RequestBuilder` - and, within it, one Body editor plus the script editors on whichever request's Elements tab the user actually opened - all disposed together (`@monaco-editor/react`'s own unmount cleanup) when that builder unmounts. `AuthPanel` owns the mode picker (it is the only host that offers `inherit`) and delegates every field group to the shared [`AuthFields`](#shared-auth-fields-componentssharedauthfields), injecting a variable-aware `VariableInput`; OAuth 2.0 reaches [`OAuth2Form`](#shared-oauth-20-form-componentssharedoauth2form) through it. `ElementsPanel` replaces the old Pre-request and Tests tabs with one **Elements** tab (issue #1512): extractors, assertions, timers and scripts, all typed behaviours run by the engine's element pipeline at a fixed phase, edited through the shared [`ElementList`](#shared-elementlist-componentssharedelementlist) primitive. A script is a `script.pre` / `script.post` element now, edited through `ElementList`'s bespoke Monaco form (`elementForms.ts`) rather than a form of its own - the two script tabs, `ScriptPanel` and `script-variants.tsx`, are gone. `ElementsPanel` renders `InheritedElementsNotice` (the element equivalent of `AuthInheritBanner`) to name which ancestor collections contribute an element the request inherits, with a per-element **Disable** toggle that writes an `inherit.disable` entry into the request's own list rather than editing the ancestor; it accepts an optional `entries` prop so a stored-run view can supply the resolved list directly instead of reading the live chain. `LegacyScriptNotice` is unchanged: a run recorded before scripts were split into parts still shows its one glued string, read-only, since the request's own part cannot be recovered from it. `AuthInheritBanner` and `InheritedElementsNotice` share their chrome through `ChainCard` - the tinted box, summary row, captioned list and hairline separators - which they previously wrote out twice, identically. `ParamsPanel` edits one `params[]` in two tables: the query rows, and under them a **Path variables** table (an `Eyebrow`-labelled region, present only while the URL has a `:name` segment) of the path rows (issue #1764). Each table writes its own half back beside the other's, so a query edit cannot drop a path value. A query edit rebuilds the URL's query with `buildUrlWithParams`, which keeps the URL's own bytes for every row it already carries and encodes only the rest with Postman's query rule (issue #1771), so an unedited `%7C` stays `%7C` and an edited `a|b` goes out as `a|b`. The panel passes the rows from before the edit, and only a row carried over unchanged (same id, key, value and `valueless`) may claim a pair by its decoded spelling, the case an older version's decoded row needs; an edited `+` over `%2B` is written `+`. A bulk commit keeps the id of every line it restates (`parseParamsFromText`) so those rows still count as carried over. An empty value writes `key=` and a `valueless` row (a URL's `?flag`, a Postman `"value": null`, a bulk line with no `=`) a bare `key`; typing into or clearing a value makes the row an ordinary one (issue #1772). The table has no control for `valueless`: it shows such a row with an empty value, and only bulk edit (a line with no `=`) or the URL can make one. The query ends at the fragment, which is put back after the rebuilt query. A path row's key comes from the URL, so that table locks the key and offers no remove; the value, and the enable box, stay the user's. It sits in `BulkEditor`'s `after` slot, visible in both modes, because bulk edit is the query's `key=value` text and a path row has no line there. The **Sends** line substitutes path values before resolving the URL, each value resolved and then encoded, as compose does (`resolveSendsUrl` / `sendsCacheInput` / `sendsResolver` in `utils/sends-url.ts`; the unnamed request's tab title resolves through the same function, #2637), and then shows the result with every secret variable value and the request's own auth credential (in each encoded spelling) replaced by `••••` at render, after the stable-resolve cache, so the cache and a dynamic variable's value are untouched (#1806; the same `collectSecrets` and `createSecretMasker` the code snippets use), and the tab's count is both tables' enabled rows, a path row with no value yet included (it is a row the tab shows, and the one most likely to need filling in). `InfoPanel` holds the request **name** (autosaved: committed trimmed on blur, a blank one refused out loud via `reportBlankNameRefused()` and the stored name restored through the context's `restoreStoredName()`) and its description, and is first because those are the first things you want to read about a request; it replaced `RequestDescription`, a permanent ~30px band above the tab strip that every request paid for whether or not it had one. Its mark is a presence dot (`TabCount`'s `presence` mode, #2199), not a count, matching Body, Auth and Settings; Params, Headers and Elements keep their numbers. `ExamplesPanel` lists the request's saved example responses (issues #481, #588): one collapsed row per example with its status chip and name, expanding to the recorded headers and a `ResponseBody` view. Rows can be **removed** but not edited - delete landed with the response viewer's *Save as example* (below) because an example you can create and never remove is the #553 zombie shape at a smaller scale, and it is confirmed through `DeleteConfirmDialog` because a mock server answers with the first example of a matched route. It is not scoped to app-saved rows: the engine's route is not, and telling the two apart here would mean reading an `origin` no surface displays. A row whose `bodyTruncated` is set carries an amber **Partial body** chip beside its name (issue #659) - a mock server answers with the stored bytes as though they were a whole response, and until the engine had the column the fact lived only in the example's *name*, which a rename at save time erased. Each row also carries a **Copy for agent** icon button beside delete (`exampleReference`, #2047); it names the *saved* request from `useRequestQuery`, not the builder's draft, with its collection chain from `useCollectionsQuery`, and is absent until that row has loaded. It keeps three empty-looking states apart (unsaved request, no examples, failed read), because collapsing them is how an unreachable engine reads as "this request documents nothing"; it carries no badge, since the count lives behind a query and a tab row should not wait on the network to finish drawing. `SettingsPanel` holds the per-request execution settings - the **Protocol**, the redirect policy (**Follow redirects** + **Maximum redirects**), **Verify TLS certificate**, Postman's protocol switches under **Cookies & URL** (**Disable cookie jar**, **Send URL without encoding**) and **Don't send automatic headers** (issue #1765), and the **Event stream** toggle (issue #574); the tab strip marks it with a presence dot via `isRequestSettingsNonDefault` (in `utils/request-state`) only when the request departs from the engine defaults. Its four rows are the settings screen's own - [`SelectSettingRow` / `ToggleRow` / `NumberSettingRow`](#row-primitives-and-save-models) - rather than a fourth copy of them (issue #702), so this tab is the first consumer of those primitives outside `modules/settings`. Sections are `Eyebrow` labels, one tier above the rows' `text-sm font-medium`: they were `h3`s set in the *same* type as the control labels, which read as six sibling headings, and "Protocol" was a heading with a label of the same name directly under it. A section holding one row is that row, so only **Redirects** (two rows) carries a heading. The scope line is stated once at the top; the only row it is not true of - **Event stream**, which a load test always buffers - says so itself. The automatic-headers list is **stored** (`disabledSystemHeaders`), unlike the Headers tab's per-send untick (`disabledDefaultHeaders`, #1229), and each copy says which it is; `utils/automatic-headers.ts` builds it: `User-Agent`, `Accept`, `Accept-Encoding`, `Content-Type`, then every other header `GET /request-defaults` declares (the correlation id), then any other stored name so it stays removable. Stored names Vayu keeps for the Postman export without applying (`Postman-Token`, `Connection` and `Cache-Control`, which it never sends; `Host` and `Content-Length`, which HTTP/1.1 needs) are read-only chips with that reason beside them. `HeadersPanel` shows a stored-off default as unticked and disabled, "off for this request in Settings" The tab row **fits and overflows** rather than scrolling (#2200): `useFittedTabs` measures the wrapper around the `TabsList` and the tabs that do not fit go to a `+N` `TabOverflowMenu` beside it (see `TabStrip`); the active tab is never one of them, and `markAllowance` budgets each badged tab's mark. Choosing from the menu calls `setActiveTab`. A hidden tab's count or presence dot is drawn on its menu item (the same `TabCount` node its trigger would get); this strip passes no `attention`, as nothing on it is an error. → `tab-overflow.test.tsx`. |
| `components/ResponseViewer/` | `index`, `ResponseCookies` (one row per received `Set-Cookie` line, each parsed on its own by `parseSetCookieLine` so a comma in a value never splits it, issue #2460; a response with no header lines - a row stored before them, a stream's `open` frame - falls back to splitting the folded header with `parseSetCookie`; a send that followed redirects adds a second group, **Set during redirects**, one sub-heading and table per hop that set a cookie, read from `ResponseState.redirects` and never labelled stored, issue #2461), `ResponseTimingTab` (the Wire / Queue / Vayu / Total summary under the timeline - **Vayu** is `timing.engineMs`, shown only when present, and Queue is never labelled as it), `TestResults`, `ElementOutcomes` (the Elements list beside it: one row per extractor, assertion, timer or control element, its outcome, a timer's wait in ms - `0 ms` for a silenced one - and a passing row's message, a `control.transaction`'s name, inline; a failure's message stays on hover; issue #1941), `SchemaValidation`, `ConsoleOutput`, `RawRequestResponse`, `ClientErrorView`, `SaveAsExampleDialog` + `save-as-example.ts` (status bar, actions and the Headers tab, which lists the request as sent, now come from `shared/response-viewer/`). `ClientErrorView` is the **Body tab's content** for a `status: 0` response (a timeout, a refused connection, a failed handshake), not a replacement for the pane (issue #1884): the other tabs stay, so Raw shows the request that went out (and no response under it), Headers the sent headers, and Timing the phases the engine measured. Vayu's own failures (`ENGINE_ERROR`, `INTERNAL_ERROR`) draw a different glyph from a target's, so a stopped engine never looks like a refused connection. Save as example is absent for it, there being no exchange to keep. Between the status band and the tab row, outside every tab, a warning `Callout` titled **Authentication not sent** draws the engine's `authNotice` (issue #2474) when the response has one: the request's auth mode is one the engine stores but does not execute (`digest`, `ntlm`, ...), so it went out bare and the target's 401 is the expected answer. It is a band rather than a Body-tab notice because it explains the status and must show on every tab and on a `status: 0` failure, whose Body tab is `ClientErrorView`. → `auth-notice.test.tsx`. The Console tab renders whenever the response carries console logs **or** a `preScriptError`/`postScriptError`, so a script that throws before logging still shows its error rather than a silent 200. The **Events** tab (issue #574) renders `ResponseEvents`, which now lives in `shared/response-viewer/` because a load run's sampled stream shows the same list - see that section. **Save as example** (issue #588) sits at the right of the tab row rather than beside Copy and Download, which live in the body pane because that is what they act on - this acts on the whole exchange. It is **absent**, not disabled, for an unsaved request (no id to nest an example under, and the Examples tab already says so in a sentence) and while a stream is still open (the placeholder response has no body yet). It is **disabled**, behind a `DisabledHint`, for a body the engine sent as base64 (`exampleRefusal`, issue #2458): an example's body is UTF-8 text. The payload rules that must not drift live in `save-as-example.ts`, not the dialog: `origin: "user"`, the importers' Content-Type mapping, never an `order`, and `savedFrom` (issue #1763) - the request as written at Send (`sentRequest`, which only a live send carries), the server's status text, the response time and when it arrived - sent only when the response has that snapshot, so a restored one saves without it. The **Tests** tab carries two kinds of result (issue #628): what a Tests script asserted, and `SchemaValidation` - the verdict against the schema the bound spec declares. It renders there rather than in a tab of its own because the tab set is a constant (see the note in `index.tsx`), and its chip in the status band comes from `shared/response-viewer/ValidationChip`. A response whose collection binds no document carries no verdict, and the tab shows exactly what it always did. The Body tab stacks **two independent notices** above the pane, and they are not exclusive (issue #1157): "Body truncated for storage" is `maxTraceBodyBytes` shortening a stored trace, which a re-send undoes, and "Body capped while reading" is the engine having stopped at `maxDesignResponseBodyBytes`, which a re-send reproduces - the remedy there is raising **Max Design Response Body** in Settings. A third, the pane's own 2 MB formatting limit, is rendered by `shared/response-viewer/ResponseBody` itself The tab row **fits and overflows** rather than scrolling (#2200): the eight sub-tabs are one `RESPONSE_TABS` list that the fit measures and the triggers draw from, and the ones that do not fit go to a `+N` `TabOverflowMenu` beside the `TabsList`. Save as example is a `shrink-0` sibling outside the measured wrapper, so it keeps its room. A hidden Headers, Console, Tests or Events tab keeps its count, error dot or result chip on its menu item, and a script error (Console) or a failing test run (Tests) in the menu also puts an error dot on the `+N` trigger. → `tab-overflow.test.tsx`. |
| `components/LoadTestConfigDialog/` | Load-test configuration dialog (mode, duration, RPS, virtual users, …). Its first field is the **Run label** (optional; id `lt-comment`, sent as the payload's `comment`), hinted "Shown with this run in History." (History draws it as the run's **Comment**, under the title - see [Detail](#history-moduleshistory)). Renders `OAuth2LoadTestGuard` when the request's effective auth is OAuth 2.0. A second disclosure, **Pass/fail budgets**, declares the run's latency / error-rate / throughput limits; the field table and its rules are `budgets.ts`, and the p99 field is seeded from the `sloThresholdMs` client setting so that setting becomes the default budget rather than a parallel notion of "too slow". The closed card is not silent about them (issue #2194): `DisclosureCard`'s optional `summary` prop carries `summariseBudgets` ("N budgets active", "No budgets", or the lone budget named, e.g. "p99 latency at most 200 ms"), and the one explainer `BUDGETS_EXPLAINER` is shared with `RunCollectionDialog`. Budgets the user did not type this time are named in an info notice with a **Clear carried-over budgets** button (`carried-budgets.ts`: `findCarriedBudgets` records each field's source on restore, `memo` or the `slo` seed; `stillCarried` stops claiming a field once the user edits it; `buildNotices` draws it). The memo's `budgetsFrom: { requestName }` provenance is written on Start only when that Start changed the budgets, from `referenceOwner`'s request name; a memo without it reads "your last load test". On Start the same carried set, minus anything the user edited or cleared, is sent as `carriedBudgets` (#2195): `carriedThresholdKeys` spells each as its `thresholds` key (a fixed budget by its `BudgetKey`, whether the memo or the SLO seed carried it; a custom row as `custom.<name>.<stat>`), and `buildLoadTestConfig` keeps only the keys the built `thresholds` holds and omits the field when none remain, so the report can tag those checks. A budget out of the engine's range blocks Start with a named message instead of being dropped from the payload. Below the six fixed fields sits a repeatable **Custom metric budgets** list (issue #1579, `CustomBudgetRows.tsx`): a typed metric name, a stat from the six the engine reads (`p50`, `p95`, `p99`, `max`, `value`, `rate`) and a ceiling, folded into the payload as `custom.<name>.<stat>`. The name is typed rather than picked, because the engine validates the key's shape and not that the name is one this run records - the same call MCP's `thresholdsInput` already made for this key family - and a half-filled or duplicated row blocks Start rather than being silently dropped. `budgets.ts` is reused, not copied, by `modules/collections/RunCollectionDialog.tsx`'s own Pass/fail budgets disclosure (issue #1564: the engine now judges a collection run against the same block), and the field's own `NumberField` moved to [`components/shared/`](#number-field-componentssharednumberfieldtsx) for the same reason. It also reads `GET /request-defaults` for **both** scopes and names the difference in one notice when they disagree (`default-headers.ts`), because the Headers tab shows the design answer and a load run resolves `Accept-Encoding` from `loadNegotiateCompression`. Its data file picker declares the contract on a pick and clears it on Remove (issue #2050), through the shared `hooks/useDataContractWriter.ts`, for the collection the request's contract resolves to and for nothing when the request is in no collection; the `request` prop (the builder's pending draft, converted to the stored shapes) is audited through `hooks/useColumnAudit.ts` against the picked file's columns. The three disclosures are components of their own - `RecordingSection.tsx` (Recording & limits), `BudgetsSection.tsx` (Pass/fail budgets), `MonitoringSection.tsx` (Server monitoring) - over the shared `DisclosureCard.tsx` chrome; each takes its draft slice and setters from `index.tsx`, which keeps the dialog shell, the mode row and the Start handler, which hands the draft to `buildLoadTestConfig` (`buildLoadTestConfig.ts`, the one place the `LoadTestConfig` payload is assembled per mode); the profile's own number fields (the ones the chosen mode uses, plus the stream caps) are `ProfileFields.tsx`, and `profile.ts` says which modes take a duration and holds `profileParams`, the neutral per-mode field selection that `buildLoadTestConfig` spells snake_case and `scenarioProfile.ts` spells for a scenario payload. `ProfilePicker.tsx` and `ProfileFields.tsx` are reused, not copied, by `RunCollectionDialog`'s load profile (issue #2137): the picker narrows with `modes` and rewords with `copy`, the fields take an `iterationsLabel`, and `summarise` takes a `"sequence"` subject. The data file is `useLoadTestDataFile.ts` (declared-file pre-fill, contract write on a pick, column audit) drawn by `DataFileSection.tsx`; the Scripts override is `ScriptsOverrideToggle.tsx`; and `validation.ts` turns the draft into the messages that block Start and that `buildNotices` shows. The last run's settings are read, clamped into the current Settings ceilings and written back by the `useSavedLoadTestConfig` hook (`useSavedLoadTestConfig.ts`), which owns the `SavedLoadTestConfig` memo shape; the notice stack (blocking above advisory) is `buildNotices` in `notices.tsx`. The dialog's description line is the **target** (issue #2117): the builder hands it `method` and `url`, the URL resolved through `useVariableResolver`'s `resolveString` (a preview, so `compose-plumbing.test.ts` allows that one call), and `TargetLine.tsx` draws the method badge, the host and the URL middle-truncated by `truncateUrl` with the whole value in its `title`. `target.ts` classifies that URL once - host plus `isLocalHost` (`lib/host-locality.ts`, mirrored from the MCP gate's `isPrivateHost`) - and the result feeds both the line and an **info** notice, "This target is not on your machine or network", that says how many requests Starting sends (`totalRequests` in `summary.ts`, the same arithmetic the summary sentence uses; "as many requests as the target can answer" where the count is the target's, and no figure at all while a blocking error is live, as the summary withholds its own). It advises and never gates Start, where MCP's allowlist refuses. A `{{token}}` in the host that resolved to nothing reads "Host unknown: `{{baseUrl}}` has no value in any scope." and raises no advisory; a token only in the path leaves the host known. Both props are optional, and a caller that passes no `url` keeps the old one-line description. Its info notice **Tests run afterwards, on a sample** (#2133) tells the user, before Start, that a post-request script is replayed on about 1 in `RESPONSE_SAMPLE_PERIOD` (100) responses, at most `MAX_RESPONSE_SAMPLES` (1,000) (`constants/load-test.ts`, pinned to the engine's defaults by `load-test.engine-parity.test.ts`), while `assert.*` elements check every response. The `hasPostRequestScript` prop is `hasReplayedPostScript(elementsParts(...))` in the builder, so an inherited collection script counts and a `script.post` marked `config.inline` does not; the notice is hidden at Scripts = All inline, and the Scripts hint and the sample-rate slider's hint (a different knob, for stored timing traces) say the same thing in their own terms. When the builder has a saved row for the request, it hands the dialog `referenceOwner` and every budget row gets a "Copy for agent" button (#2047); `BudgetsSection` and `CustomBudgetRows` forward it, and the collection runner passes none. The same owner puts a **Copy request for agent** button (`CopyForAgentButton`) beside the host in `TargetLine.tsx` (#2230): the builder also passes `collectionPath` (the ancestor names, root first) so the line carries `in A / B` like the sidebar's copy, and an unsaved request gets no button. A muted footer closes the dialog body for every caller - "An agent can start this run too with `start_load_run` (Settings › AI agents (MCP)). Its host must be on the Target allowlist." - its two Settings names read from `appSetting("mcp-allowlist")` and `getAppPanel`, so a rename there reaches it. A muted line under the description names where the per-request timeout lives (Default Request Timeout, Settings › Network & connectivity) and that a Think time element on the request's Elements tab paces virtual users (#2229). The dialog is two panes from the `lg` breakpoint (`max-w-xl lg:max-w-4xl`, #2231) and one column below it: the left pane is the Run label, profile, its fields and summary; the right is Scripts, the data file and the Recording, Budgets and Monitoring disclosures; the OAuth guard and the agent footer span both. The notices are pinned between the header and `DialogBody` (capped at `max-h-[30vh]`, scrolling inside), so a blocking one stays visible beside the pinned Start | 
| `components/OAuth2LoadTestGuard.tsx`, `components/oauth2-load-test-coverage.ts` | Warns when a duration-based load test would outlive its access token, in the cases the engine will *not* renew mid-run (a query-placed token, `autoRefreshToken: false`, an `authorization_code` grant with no refresh token): offers **Refresh** when a fresh token would cover the run, or **blocks Start** (with a "Start anyway" override) when even a fresh token can't. A run the engine will keep current gets an info line, not a warning. The pure coverage decision lives in `oauth2-load-test-coverage.ts`, whose `isMidRunRefreshable` mirrors the config-and-token cases of the engine's `plan_auth_refresh` - not its last one, a user-supplied `Authorization` header that beats the token, which the guard is never handed the headers to see. Change one, change both |
| `shared/BulkEditor.tsx` | The table/text toggle above a `KeyValueEditor`, and the textarea it swaps in - `ParamsPanel` and `HeadersPanel` had a copy each. It stayed in the module when the table left for [`components/shared/`](#shared-keyvalue-editor-componentssharedkeyvalueeditor) (issue #567): the shared bucket is what *several* features share, and only these two panels bulk-edit. The formats are the callers' - headers are `Name: value`, params are `key=value` - so a parse, a format and the syntax note are what it takes in. A leading `// ` on a line disables that row, and only the key is trimmed - a value's whitespace, past the one conventional space right after the separator, is sent exactly as typed (issue #1480). `BulkEditor` itself always commits the draft on the way back to the table (that is the staging contract `BulkEditor.test.tsx` pins); each caller's `onCommit`/`handleBulkEdit` skips the update instead when the committed text describes the same rows it started with, so opening and closing the editor without typing cannot re-enable a row or dirty the request. **`after` renders in both modes.** The engine's declared headers and the resolved URL used to be part of `children`, so they vanished the moment you switched to text - exactly when a pasted block most wants checking against what it will actually send; only the table itself and its empty-state `tableHeader` are table-only now. A **Discard** button appears beside the mode toggle once the draft diverges from the rows it opened against, leaving text mode without committing - the toggle itself still always commits, which is the contract above |
| `hooks/`, `utils/` | Module hooks - `useHeadersManager`, and `useVariableSupport`, the one adapter from the request-builder context to the `VariableSupport` prop shape (memoised: it is a prop on a `memo`-wrapped row); `utils/key-value`, which is now the execution-shaped helpers `toHeaderRows` (the Headers table as the engine takes it: every enabled row with a key, in row order, a repeated name repeated and each row in its own case, with the spaces and tabs around its name trimmed as the engine trims them, issues #2466 and #2467 - never a record, which would keep one value per key; `header-rows.conformance.test.ts` holds it to the engine's `stored_header_rows` over one shared fixture) and `bodyModeHeaders` (the names whose last row the body mode wrote, compared trimmed and without case) (the row-model half - `toKeyValueItems`, `toKeyValueEntries`, `withTrailingBlank` - moved to the table it describes, see [Shared Key/Value Editor](#shared-keyvalue-editor-componentssharedkeyvalueeditor)); `utils/system-headers`, which since issue #1229 owns nothing but the recognition of the rows a pre-#1229 client wrote (a plain-version `X-Vayu-Version`, a lowercase-v4-UUID-valued `X-Request-ID`, a `Vayu/<plain version>` `User-Agent` - issue #1491 tightened all three to that exact value shape) and drops them from that conversion in `toHeaderItems`, unless the engine's own startup pass has already disabled and marked the row (`source: "legacy-default"`), in which case it passes through like any other disabled row - the same rules and the same marker the engine applies to the stored copy at startup. Id generation is `lib/id.ts`, since `services/curl/` and the history module already reached across the module boundary for it |

> **cURL / wget import:** pasting a `curl` or `wget` command into the URL field auto-populates the whole request (method, URL, params, headers, body, auth). Auth maps `-u`/`--user` (and wget `--http-user`/`--http-password`) to Basic, curl `--oauth2-bearer` to Bearer, and `--digest`/`--ntlm` beside `-u` to those stored-but-unresolved modes rather than silently relabelling the credentials as Basic (issue #1445; `--negotiate` has no matching mode here and is disclosed instead of guessed at); an `Authorization` header is left as a raw header (to preserve `{{variables}}`). Form-shaped `-d`/`--data` without an explicit `Content-Type` maps to `x-www-form-urlencoded` rows (curl's on-the-wire default, decoded once so a `%`-escaped value is not re-encoded on the next generated snippet), while a raw JSON/text blob stays a text body; `--data-urlencode` is one field per occurrence, its value kept exactly as typed. `-L`/`--location` and `--max-redirs` map to the request's redirect settings - curl's own default is *not* to follow, unlike Vayu's, so a plain command with no `-L` genuinely means "do not follow" rather than "unspecified". Detection + parsing live in `services/curl/` (`tokenize.ts` shell tokenizer + `parseCurl.ts`), kept separate from the collection `importers/` pipeline since this targets the active request. The paste is a request-shape replacement - identity (`id`, `name`, `collectionId`) and scripts are preserved; a file the command reads keeps only its path, marked unresolved so the engine sends it only once it is picked again in the editor or lives under a folder allowed in Settings > Files: `-F field=@file` becomes a form-data file row (`-F 'field=text;type=application/json'` a text row that keeps its type), and a lone `--data-binary @file`, `-d @file` or wget `--post-file` becomes a `binary` body (`-d @` is disclosed, because curl strips the file's newlines and Vayu does not), as does `-T`/`--upload-file`, which also makes the request a PUT unless `-X` says otherwise and appends the file name to a URL that names none; `--data-raw` never reads a file, a file body beside other data and a body from standard input are disclosed, and a value-carrying flag this parser has no case for is disclosed rather than risking its value for the URL that follows. The URL itself is chosen among the command's bare tokens by shape - an explicit scheme or a hostname-shaped bare address - rather than "first bare token wins", so an unrecognized flag's swallowed value (e.g. `--retry-delay 5`) can never bump the real URL out of its slot; any other bare token is disclosed as an ignored argument (issue #1445). Non-command pastes fall through to normal input.

> **Body tabs** support `none` / `json` / `text` / `graphql` / `jsonrpc` / `xml` / `form-data` / `x-www-form-urlencoded` / `binary`, from the one table in `panels/body/body-modes.ts`. **Whichever editor a mode brings fills the pane** - the box is a `flex-1` child of the tab panel with a `min-h-40` floor and no ceiling, and the two script tabs are the same shape. It was a 320px box (350px for the scripts) with a drag handle under it, inside a panel that already has the request pane's full height, so a tall window showed a slice of an editor over empty panel and the drag that fixed it died with the Radix unmount on the next tab switch (#1323); how tall an editor is now comes from the request/response splitter, which persists - the picker renders it and `body-editor-completion.test.tsx` derives from it which modes to render and check for `{{variable}}` completion, so a mode added without a completion-capable language fails that guard instead of losing the feature quietly. The `jsonrpc` mode is the plain code editor with Monaco's `json` language and an auto-`Content-Type: application/json` - a JSON-RPC call is one JSON document, and the frame around it (`"jsonrpc":"2.0"`, plus an `id` when the call names none) is completed engine-side at the chokepoint every client shares, so there is no structure for this side to edit and no component of its own. It shares the `raw` draft bucket with `json` / `text` for that reason (see [state-management](state-management.md#requestbuildercontext---body-drafts)). The `xml` mode is the same pane with Monaco's `xml` language and an auto-`Content-Type: application/xml`, and shares that bucket too: SOAP and legacy-enterprise APIs are HTTP plus a document the author writes whole, so the mode buys highlighting, `{{variable}}` completion (its `xml` language is in `BODY_LANGUAGES`, which it was missing from until #1214) and the header rather than an editor of its own - the engine sends `content` byte for byte with no envelope, and a hand-typed `application/soap+xml` survives the mode change like any other header the user wrote. The `graphql` mode renders a split resizable editor: a **Query** pane (Monaco `graphql` language with diagnostics, autocomplete, hover, and formatting) and a **Variables** pane (Monaco `json` with schema-derived validation). The Variables pane badges its text when it is not strict JSON - *Templated* for `{{variable}}` tokens, which are resolved and sent, *Not sent* for text the envelope cannot carry - because the two are opposite things on the wire. The editor no longer contradicts the badge: its markers come from a masked twin of the pane (`lib/graphql/variables-diagnostics.ts`), so a token draws no squiggle and everything around it stays validated. Its in-progress text lives in `RequestBuilderProvider` (see [state-management](state-management.md#requestbuildercontext---the-headers-a-setting-added)) for the body drafts' reason: Radix unmounts the inactive tab. **The Variables pane collapses to its own header**, which is the control - the whole bar is the button, since a narrow activator in a wide box is the composite-row hit-area trap. Collapsed, it keeps its badges on screen (a *Not sent* the user cannot see the editor for is exactly when the badge matters) and the query editor takes the height back; `collapsedSize` is the header's own 32px (`--spacing-band`, held by `titlebar-height.test.ts`) rather than a percentage, so the bar is neither clipped in a short stack nor floating above dead editor in a tall one. The collapse *and* the height to reopen at are in `layout-store` (`graphqlVariablesCollapsed` / `graphqlVariablesSize`, persisted), not component state and not `explorer-store`: the panel's own memory dies with the Radix unmount, and how tall a user wants a pane is a preference like every other one in that store. An insertion that leaves variables needing a value opens the pane on its own - the one moment the badge alone is not enough, because the user now has to type into the editor it names. A document defining more than one named operation also gets an **operation picker** in the Query pane's header, which writes the envelope's `operationName` - the panes carry that field (and any other envelope key) through every edit, so an imported multi-operation request keeps executing the operation it names. The picker keeps the header's right side, and a saved request gets a copy button beside it (not inside the Select, whose trigger would open the list) that puts the chosen operation's agent reference on the clipboard (`graphqlOperationReference`); it is absent for an unsaved request, with no `operationName` set, and when there is no picker. Its **left edge carries one compound schema control, in the same place whether the explorer is open or closed**: the pane toggle, then the status badge (`panels/body/SchemaStatusBadge.tsx`, sentence in `lib/graphql/schema-status.ts`), then a standing Refresh. The toggle sits at that edge because the explorer is the first panel of the horizontal group and so opens on the **left**, and its icon names that side (`PanelLeftOpen` / `PanelLeftClose`, `aria-expanded` bound to `explorer-store`); it used to sit at the far right drawing a `PanelRight*` pair, pointing away from the pane it opened (#1224). Only the toggle's icon and label change with the pane's state; nothing moves. *One standing Refresh* now holds by construction - this is the only Refresh for the subject anywhere, the explorer's and the context bar's having gone - rather than by the transparency that bought the rule before: the header's Refresh used to be invisible until hover or keyboard focus (#455, #507), which answered the duplication with a control the user had to know about already, and left the real duplicate (the context bar's) standing in a combination no single-component test could see. **Scripts** are two separate panels - pre-request and test - not a single tab.

> **The Body tab's Resolved view masks secrets** (#1813). In the json, text, jsonrpc and xml modes it prints `resolveField(request.body, bodyFieldContext(mode, body)).text` with every secret variable value replaced by `••••` at render, after the stable-resolve memo (so a `{{$randomInt}}` stays put), through `useVariableSupport`'s `maskSecrets` - the same masker the Params "Sends" line and the key/value peeks use. Source text and non-secret values stay as written; GraphQL has no resolved display (its resolved URL and auth only key the schema cache). With a data row picked, a cell is written for the body's mode as the bind writes it (escaped in a JSON string, escaped for its place in XML), and a row the send would refuse - a token in an XML comment or processing instruction - is named in a warning `Callout` above the view (issue #2639).

> **The schema explorer docks beside the query pane** (`panels/body/graphql-explorer/SchemaExplorer.tsx`, opened and closed from the one toggle in the Query header). **Its header carries only what belongs to the pane**: the search box and the descriptions show/hide, in one row. It held five - status and freshness, Refresh and the close as well - which needed two rows, because in a pane that can be 18% of the editor area the search box, the only control that wants width, competed with the status text for it. Those three are the subject's rather than the pane's and moved to the Query header (#1224), where they stand in one place whether this pane is open or shut; the search box has the row to itself again. It takes the cache's `SchemaEntry` as one prop rather than status, schema and freshness as three, for the reason the body reads it as one: they are four faces of a single state and separately they can render a frame apart. A WAI-ARIA tree over the endpoint's Query / Mutation / Subscription / Types, where a field row draws its name, its result type and a muted argument count rather than the argument list itself - the full signature leads its tooltip instead, ahead of the description - and a field that takes arguments expands into an **Arguments** group, one row per argument, above the fields of what it returns; inline descriptions, struck-through deprecations and a search that spans the whole schema (`/` focuses it) round it out. The search ranks in **three tiers - name, then signature, then description** - reports which of the three found each row, and marks the matched run wherever it found it, so every row says why it is in the list. **Results are grouped under the same Query / Mutation / Subscription / Types headings the tree uses, and every field row names the type that declares it** (`App.accessScopes`, the owner in muted text beside the name rather than inside it, so highlighting still marks the name alone). Flattened, three types declaring `accessScopes` were three indistinguishable rows and nothing on screen said which one Query could reach; the branch and the owner are the address the tree carried in its shape, and the results now carry it in text. The headings are `role="presentation"` rather than a `role="group"` per branch, because the roving treeview reads parentage off the DOM and a wrapper holding several rows would make the first of them read as the parent of the rest. It spans the whole schema literally, enum values and input-object fields included, and inside the name tier the closest match comes first (earliest offset, then shortest name) so the row the user typed is not cut off by the result limit. Descriptions are a tier rather than more haystack because they are prose: folded in with signatures, a common word matches most of the schema through them and drowns the type matches that tier exists to surface. A row matched only through its *signature* stays unmarked, which is the difference showing rather than being hidden; a row is drawn with its full description only when the **description is why it matched**, because clipped to one line that description is usually cut off before the word that put the row in the results. That asks the tier, not the offset: both offsets are reported whatever the tier, so `Query.search` - named `search`, described "Search across users and posts." - answered the looser question yes and drew its whole paragraph over the results the user was reading. Descriptions are otherwise clipped to one line, with a **show/hide in the pane header** (remembered per schema in `explorer-store`) for reading them in full - one pane-level control rather than a per-row disclosure, since a third target inside a 24px row is the composite-row hit-area trap `drawer-row-hit-area` was written against. It is *beside the editor rather than in the context bar* because the bar clamps to 220-480px and because insertion wants to be next to the cursor it inserts at - the bar gets the status half instead (`GraphQLSection`, above). Rows are windowed with `useGrowingWindow`, not a virtualisation library, and keyboard navigation reuses `useRovingTreeFocus` rather than a second copy of the treeview pattern - which is what the per-row `aria-level` buys beyond the announcement. This tree renders every row, at whatever depth, as a direct child of the `role="tree"` element, so its nesting says nothing about what owns what; the hook reads the level for parentage, and until it did, Left-arrow here found no parent to step out to and silently did nothing (#1237). **A result row carries no expand toggle**: it is derived from the index and has no children to show, so the chevron flipped `aria-expanded` with nothing appearing beneath it - the "clicking the row does nothing" of #1226. Its leading control **shows the row in the tree** instead (`treeLocationOf` reconstructs the address from the ids the tree itself builds; `revealPath` opens that path as a union and spends the search term), and it takes the row-actions slot the treeview already reaches from a keyboard rather than adding a second tab stop inside a single-tab-stop tree. **A row that holds rows opens on activation** - a branch, the "Returned by" container, and the "Arguments" container - since Enter on a container had nothing to insert and therefore did nothing at all. Activating an **argument** row writes it onto its field as a `$variable`, declared on the operation, inserting the field first by the ordinary rules when the document does not select it yet; an argument the selection already carries selects the existing one rather than writing a second, and one under a subscription field is refused by naming the subscription, not the argument. Activating a row calls `insert-skeleton.ts`; the resulting query **and** variables are written in one `serializeGraphQLBody` call, since two writes would each re-serialise the envelope and the second would undo the first. The caret is placed in an effect keyed on the new query, because the pane is `value`-controlled and Monaco's model still holds the old text at the moment of the click. Activating a row whose leaf the selection set **already holds** writes nothing: the existing line is selected and revealed instead, and the live region says it is already selected. Duplicate fields are valid GraphQL - they merge - so this is not the never-produce-an-invalid-document contract but the second click adding a line the user cannot tell from the first; the narrowing is deliberate, since a field with required arguments can honestly repeat and an object field's second copy brings its own selection. Every insertion, every already-there, and every refusal (a subscription, an enum value, a field nothing in Query or Mutation can reach) reaches a polite live region - the same mounted-empty pattern as `ResponseAnnouncer` - **and a refusal also lands visibly in the pane** as a `Callout`, cleared by the next activation that succeeds. The other two show themselves: an insertion is text in the editor, an already-there selects the line it means. A refusal reaching `sr-only` text alone was a click that, to a sighted user, did nothing. The explorer performs **no introspection of its own**: it renders the schema cache, and it offers no Refresh - the one standing Refresh is the Query header's (above), on screen in both states, so the pane never has to be opened to reach it.

> **The Event stream toggle, the Events tab and the Stop button** (issue #574). Turning on **Event stream** in the Settings tab makes Send consume a `text/event-stream` endpoint live: `POST /execute` answers `202 {runId, eventsUrl}` at once and the upstream's events arrive over `GET /runs/:id/events`. It is a *setting*, not a `BodyMode` - the request's body semantics are untouched, and a stream is a GET as often as it is a POST - and it is stored on the request (`requests.stream`), because it describes the endpoint rather than one send. Turning it on arms `Accept: text/event-stream` through the same reversible-side-effect rule the body mode's `Content-Type` uses, extracted to `utils/auto-header.ts` so there is one copy of it (see the GraphQL note below for the rule itself). While a stream is open the URL bar's **Send becomes Stop** (`POST /runs/:id/stop`) and the status band reads *Streaming - N events*; the eighth, always-rendered **Events** tab shows the rows. Live rows come from `stores/execution-events-store` via `hooks/useExecutionEvents` - a per-endpoint `EventSource` with its own reconnect and `?lastEventId=` resume, the inbox capture stream's shape (`services/inbox-watch-service.ts`) rather than the `SSEClient` singleton, which belongs to load and scenario runs and deliberately never reconnects. When the stream ends the provider fetches the run's report and `restore-response.ts` swaps in the stored `events` node, which is the record and the only copy carrying the truthful `totalEvents` / `eventsTruncated` markers - the same two-sources-one-list handoff `ScenarioRunView` makes. Every termination names itself (`completed`, `stopped`, `maxStreamEvents`, `maxStreamDurationMs`, `idleTimeout`, `error`) and every cap is disclosed in band. A streaming design run does **not** block a load test and is not blocked by one: they are independent surfaces. Scripts run on a streaming send (issue #575), split around the transfer - Pre-request before the stream opens, Tests once it has terminated, reading the retained events as `pm.response.events` - and the Settings panel says *when* rather than warning that they are refused, because Send has returned long before the results reach the Tests and Console panes.

> **The `binary` mode sends one file as the whole body** (`panels/body/BinaryBodyPanel.tsx`). The editor holds a path in `RequestState.binaryFile`, never bytes - the engine opens the file at send time. The file is dropped on the panel, picked with Choose file, or typed into a `VariableInput` path field (so `{{fixturesDir}}/a.bin` gets the same completion as every other field); the drop and the pick go through `components/shared/file-pick.ts`, the piece `FilePartCell` uses too. Only the drop and the pick choose the file (#2356): the preload reports the path to the main process, which records it as picked, and the panel sets `unresolved: false` until the engine's next read answers for it. A typed path is not a pick; it carries no flag and reads as not chosen. `unresolved` is otherwise the engine's own answer, derived on every read and never sent back (`lib/file-trust.ts`, [API integration](./api-integration.md#request-bodies)). The rule the engine applies: Vayu sends a file picked on this machine, or any file under a folder you allowed. So a warning `Callout` titled *Not chosen on this machine* offers **Relink** and, inside Electron, **Allow folder…** (the system picker opened at the file's folder; main allows what is chosen) for a path the engine would refuse or has not answered for yet, a *Path has a variable* one offers **Allow folder…** for any path with a variable in it (sent only from an allowed folder), and either turns into a positive note when the path already sits under an allowed folder (`isUnderFolder` in `lib/file-path.ts` - a text comparison for display; the engine's check is on canonical paths). The file line shows the name and the size the main process reports (`electronAPI.statFile`, which never reads contents and answers only for a picked file or one under an allowed folder, #2357), or *Not found on this machine* - which is also what a typed path outside every allowed folder that was never picked shows. The Content-Type field is the file's own `contentType`; `body/binary-content-type.ts` states what goes out - an enabled `Content-Type` header row, then that field, then the engine's extension table, which is not copied app-side, so the editor says "from the file extension" rather than guessing. The mode writes no Content-Type header row of its own.

> **Choosing GraphQL writes a header, and leaving GraphQL removes it.** GraphQL is sent as a JSON envelope, so picking it appends `Content-Type: application/json` to the Headers tab (unless an enabled `Content-Type` is already there) and says so in a notice with an Undo. The next mode change that no longer needs that header takes the row back out. The row is tracked **by marker, not by value or id** - a `Content-Type` the user typed carries no marker and always survives, and retyping a marked row's key or value clears the marker (`KeyValueEditor`'s `handleUpdate`), so it too survives from then on. The marker (`KeyValueEntry.source: "body-mode"`) lives on the row itself rather than in a provider-held record, so it survives a reload - the record used to be a ref the provider held, which could not (issue #1481). The rule itself lives in `utils/auto-header.ts` (`switchAutoHeader`), because the Event stream toggle needs the identical one for `Accept` (marked `"stream"`) and a hand-rolled copy of a primitive does not receive the primitive's fixes; `panels/body/content-type.ts` is what maps a body mode to the value it requires: `json`, `graphql`, `jsonrpc` and `xml` only, since the panel writes no row for `text` (the engine derives `text/plain` at send time, and `implied-content-type.conformance.test.ts` pins the panel's table, the code generators' and the mode chips to the engine's from one fixture). The engine's importer asks the same question at import time (`with_required_content_type`, see [import-collections](import-collections/postman.md)), because an imported GraphQL request never passes through the mode picker and used to reach the wire with libcurl's default `application/x-www-form-urlencoded`.

> **Choosing GraphQL on a default GET also moves the method, and leaving GraphQL puts it back** (issue #1228). A new request is a GET, and GraphQL-over-HTTP means something different on one - the document travels as query parameters, and a mutation cannot be sent that way at all - so picking the mode used to build a request the server answered with a bare `400`. The mode now sets `POST` the same reversible way it sets the header above, tracked **on the request itself** rather than in a provider-held slot: `RequestState.methodSource?: "graphql"` (issue #1505, mirroring `KeyValueEntry.source`) marks `method` as still GraphQL's, so it survives a reload the way a stale provider-held record could not (the same gap issue #1481 closed for the Content-Type row). `switchGraphQLMethod` in `panels/body/graphql-method.ts` is the rule - only from GET, only to POST, and a method the user chose is never overridden in either direction, the same "no longer ours" check `switchAutoHeader` makes on an edited row; `MethodSelector` clears the marker in the same call that sets a hand-picked method, the way `KeyValueEditor`'s `handleUpdate` clears a retyped header row's marker. A GET still reaches GraphQL by another door - the user picks it back, or an import wrote one - so the Query pane header carries a `BadgeText` reading "Sent as query parameters" whenever the method is GET, naming the transport rather than reporting an error: GET is a legitimate way to send a query, and the wrong one for a mutation.

## GraphQL Library (`lib/graphql/`)

Shared, Monaco-independent modules that power the GraphQL body mode.

| File | Role |
|---|---|
| `graphql-body.ts` | The GraphQL-over-HTTP envelope, converted to and from the two editor panes. Keeps `operationName` and any key it does not model (`extensions`) across a round trip - the pair used to carry `{query, variables}` alone, so one keystroke deleted the rest. Variables that hold `{{tokens}}` outside a string are written into the envelope verbatim (the engine resolves them before sending); variables that are broken for any other reason are still dropped, and `classifyVariables` is what the pane's badge reads to tell the two apart. A string-typed `variables` (Postman's shape) shows verbatim rather than JSON-encoded. Also `operationNames` (which operations a document defines, for the picker), `documentOutline` (kind, name **and** starting line of every operation, anonymous ones included, for the context bar's outline - `operationNames` drops all three, since it answers the narrower "what may be sent as `operationName`") and `findOperationLine` (where an outline row's operation sits in *another copy* of the document - the bar reads the stored request and the editor holds the live buffer, so a row is resolved by name rather than by carrying its line across). |
| `diagnostics.ts` | Pure (Monaco-free) diagnostic computation - syntax check via `graphql.parse` when no schema is available; full field/type validation via `graphql-language-service.getDiagnostics` when a schema is loaded. Returns 1-based `GqlMarker[]` matching Monaco's `IMarkerData` shape. `{{variable}}` tokens are masked before the pass and any marker landing on one is dropped, so the editor no longer flags an idiom the engine supports - and, because an unmasked token is a *parse* failure, the rest of the document stays validated. |
| `templates.ts` | The three maskings `{{variable}}` tokens need, split by whether the caller needs the *positions* back or the *token text* back. For GraphQL text, a length-preserving swap to a Name plus the spans, so marker positions stay usable against the original. For JSON text on the wire path, a string-aware swap to a sentinel string (tokens already inside a JSON string are left alone), so a templated variables object parses and can be written back verbatim. For JSON text being diagnosed, the same string-aware scan swapping each token for a JSON string of its exact length, plus the spans - never unmasked, which is why it can use a placeholder a user could also have typed. |
| `format.ts` | Format Document for GraphQL, via prettier's graphql parser loaded on demand. It was `print(parse(text))`, which has nowhere to hang a `#` comment and deleted every one of them; returns null on unparseable input so the caller pushes no edit. |
| `introspect.ts` | Fetches a `GraphQLSchema` by routing the standard introspection query through the engine, avoiding CORS. Composes first (`apiService.composeRequest`, `POST /compose`) so the endpoint's `{{variables}}` and its **Auth panel** config - `inherit` walked through the collection chain, OAuth 2.0 included - are resolved engine-side, then overlays the introspection query onto the composed payload and sends it with `apiService.executeRequest`. It holds no resolution logic of its own; the composed body and script parts are dropped, since introspection is not sending the user's request. The execute payload carries `transient: true` and the target's `environmentId` (issue #382), so the fetch leaves no run row, trace or History entry behind and still reads the environment's cookie jar. |
| `schema-cache.ts` | Zustand store (`useSchemaCache`) keyed by `schemaCacheKey(target)` - resolved endpoint URL **plus** the credentials it is reached with (collection scope, environment, auth block), because introspection now sends auth and two environments can point one URL at different credentials. Headers are deliberately out of the key (they are edited keystroke by keystroke); a hand-typed `Authorization` needs the Refresh button. Callers hand over a `SchemaTarget` and never build the key. States: `idle → loading → ready \| error`. `ensureSchema` skips targets already attempted; `refreshSchema` forces a re-fetch. Exposes `getActiveSchema()` and `getActiveStatus()` for Monaco providers. It keeps the active *key*, not the target it hashed from: the target sat beside it only so the context bar's Refresh could call `refreshSchema` without rebuilding the resolved URL and auth, and that Refresh is gone (#1224), so the field went with it rather than staying as state nobody reads - a caller needing a target again holds the one it already has, the way `GraphQLBody` does. |
| `schema-status.ts` | The one sentence about the schema in hand, derived from a `SchemaEntry` alone - the per-kind failure hint (#383) plus freshness. Pure and Monaco-free, beside the store it reads. Two surfaces rendered it - the explorer header's badge and the Query pane's chip - and a second copy in either is how the two came to describe one subject in different words from different panes (#455); the badge now has one home, in the Query header's schema control (#1224). |
| `language-providers.ts` | Registers Monaco language providers for the `graphql` language: completion (fields, types, directives, each carrying the kind the language service classified it as), hover type info, debounced inline diagnostics (re-runs on content change and on schema cache updates), and document formatting (`format.ts`). Completion triggers on structural characters only - never space or newline, which popped the widget so the next Enter accepted a suggestion instead of breaking the line. Call once after `loader.config`. |
| `schema-tree.ts` | The explorer's tree model and its search index. Children are computed **on demand** per expanded row rather than built into a tree up front - a schema is a graph (`User.posts` → `Post.author` → `User`), so materialising it either recurses forever or prunes branches on the user's behalf. A field row carries the `rootPath` it was reached by (`[Query.user, User.posts, Post.title]`), which is the one thing insertion cannot recover on its own; rows browsed under the Types branch have no path and say so with a null. The search index *is* materialised - one pass over the type map, no traversal - because a search has to see rows nobody expanded, and it covers **every kind `childNodes` can produce**, enum values and input-object fields included: a row browsable one click later must not answer "Nothing matches". Both of those carry a null `rootPath` like a Types-branch row, so insertion refuses them by kind rather than guessing a route. A field row also carries `returnType` - what the row draws, since an unbounded argument list dragged the result type off a 34% pane - and `args` in declaration order; a field that takes any expands into an **Arguments** container ahead of the fields of what it returns, the same shape **Returned by** already uses, and each argument row carries an `argumentOwner` naming the field and route it belongs to rather than its own, since its `name` is the argument's. An argument whose type is an input object or enum expands again into that type's members. `signature` is untouched and still the whole `(args): type` string - it is the search index's middle tier, so searching an argument name still finds the field - and the **Arguments** container and its rows are deliberately absent from that index, since an argument has no tree address of its own for `treeLocationOf` to reconstruct. Each entry keeps its name, signature and description lowercased separately rather than as one haystack, because the ranking turns on *which* of them matched; a match reports its offset in the name **and** in the description together with the **tier** it landed in, and `splitAtMatch` cuts either into the three segments the row draws - the tier because "where do I mark it" and "why is this row here" are different questions, and only the second decides how much of a description the pane owes the reader. `groupSearchMatches` partitions the ranked list by branch without reordering inside a group, and `treeLocationOf` walks a search row back to where it lives in the tree, reconstructing the address from the same id builders `childNodes` uses so the two cannot drift. **Within the name tier the closest match wins** - earliest offset, then shortest name, so an exact match needs no special case - and the whole index is scanned before the `limit` (200) cuts, because a better match than the first 200 is routinely declared after them: in declaration order, a schema of 60 `POST_*` enums ahead of its `Post` type returned 200 leaf rows and neither the type nor `Query.post`. The index arithmetic stays here, out of the component, so it is testable without a DOM. One route *into* the graph is materialised beside it: `rootFieldsReturning` reads, once per schema and cached against it, which root fields answer with a given type - the answer to the question a type row could not otherwise answer, and what a `Post` row shows as its **"Returned by"** container and inserts through. It stops at the root operation types on purpose (a one-hop answer is one the user can check at a glance, and a search through the whole graph would be back to guessing a route nobody chose), skips Subscription (browsable here, not runnable), and keys only object, interface and union types, since "what returns a String" is noise and "insert a String" is not a query. **One hop includes the members of what a field declares**: `Query.node: Node` is keyed under every type implementing `Node`, carrying a `narrowTo` the route's step passes on, because keying only the declared type left a Relay-shaped schema - one `node` field, every concrete type behind it - with no route to anything at all. A route that returns the type outright outranks one that narrows to it, so a schema of direct returns is unchanged. |
| `insert-skeleton.ts` | Turns an explorer row into an edit of the query document, under one contract: **the document still parses afterwards, and can be run**. Parsing is not enough on its own - a lone `fragment PostFields on Post { … }` is valid GraphQL holding no operation, which is what a type row used to write onto an empty document and what Send gets nothing back from. So a **type row inserts the query that returns the type** (`rootPathsToType`, best route first, a deprecated root field never chosen). A step that narrows writes the inline fragment it needs (`node(id: $id) { ... on Post { … } }`) - not the "probably compatible" guessing this module refuses, but the narrowing without which the selection would not be legal. Where no root field returns the type at all, `insertFragment` writes the definition **and the spread that uses it** - one edit, because `Fragment "X" is never used` is a validation rule and a lone appended definition rejects the whole request, the operation the user already had included. The spread's host is decided by `doTypesOverlap`, the predicate `PossibleFragmentSpreadsRule` validates with, so a fragment on a concrete type lands inside the interface or union selection it belongs in (the innermost set that can hold the spread wins, whether it matches the fragment's type exactly or merely overlaps it - a spread made from inside `... on Post` stays inside it rather than climbing out to the `Node` set that matches exactly); with no host anywhere on the cursor's chain it refuses, since parsing was never the bar. A **field found by search under a non-root type borrows the same route** rather than refusing whenever the cursor is not already inside its owner - the commonest search result there is, and the commonest refusal. A field lands in the cursor's selection set only when that set's type owns it (no inline-fragment guessing on an interface or union), then in an enclosing set, then as a new named operation; a cursor *inside* an inline fragment is read at the type that fragment names, which is the other half of the same rule - the set the app itself wrote when the route narrowed, so skipping it made a click in there insert a second copy of the whole route instead of a sibling line; a path-less row with nowhere to go is *refused out loud* rather than guessed at. Required arguments become `$variables` **and are declared on the operation that gains them** - including promoting a shorthand `{ … }` operation to `query ( … )`, which otherwise cannot carry any. `insertArgument` writes one more argument the same way, onto a field the document may not select yet: it is not a selection but is written *onto* one, so a field that is not there yet is inserted first by the ordinary rules above and the argument lands on what that wrote; an argument the selection already carries is reported rather than written twice, and one on a field behind a subscription is refused, naming the subscription rather than the argument. Also `mergeVariables`, which folds new variables into the Variables pane only when its text is strict JSON: merge, never replace, and never touch a `{{token}}` draft - what it could not write comes back as `pending` for the badge to name. |
| `explorer-store.ts` | Zustand store for the explorer's view: whether the pane is open, and per schema identity (the same `schemaCacheKey`) the search text, the expanded row ids, the scroll position and whether rows show their full description. `revealPath` opens a whole ancestor path in one write and clears the search: a union rather than a toggle, so a path already half-open does not get half-closed on the way down, and one write rather than one per level, so the tree renders once. A store rather than component state because Radix unmounts the whole Body tab on a glance at Headers - the body drafts learned this the hard way. In memory only, capped at `EXPLORER_VIEW_MAX_ENTRIES` (8, matching the schema cache): an expansion set describes a schema that may not exist next launch. |
| `reveal-store.ts` | One slot: the operation the context bar's outline asked the query editor to scroll to. The outline sits outside `RequestBuilderProvider` and the Monaco instance stays private to `GraphQLBody`, so what crosses the boundary is a request to reveal rather than the editor itself. Consume-and-clear, the same shape as the insertion effect and for the same reason - a command left in the slot is replayed on the next remount, which the Body tab does on every glance at Headers. Cleared by whoever decides its fate: `GraphQLBody` after revealing (or after failing to find the operation), the provider for a command naming another request or one whose body is no longer GraphQL. |
| `variables-schema.ts` | Derives a JSON Schema from the query's `$variable` definitions + the introspected schema via `getVariablesJSONSchema`, then applies it to the variables editor through `monaco.json.jsonDefaults` so variable values are validated and autocompleted. The query is masked before it is parsed - one `{{token}}` anywhere used to cost the pane the schema for every variable the query declares - and the schema is registered against the pane's masked twin as well as the pane itself. |
| `variables-diagnostics.ts` | What the Variables pane's JSON markers are computed from: a hidden twin model holding the pane's text with every out-of-string token masked to a same-length JSON string. Monaco's JSON worker validates the twin, and its markers are republished on the visible model minus the ones that land on a token - so a `{{token}}` no longer reads as a syntax error while a genuine mistake beside it, which the aborted parse used to swallow, now does. Filtering the worker's markers on the pane itself cannot do this: one token also earns an `End of file expected.` on the character *after* it. |

`lib/monaco-setup.ts` (sibling of `lib/graphql/`) configures `@monaco-editor/react` to use the locally bundled `monaco-editor` instead of the jsDelivr CDN, wires language web workers via Vite `?worker` imports, and calls `registerGraphqlProviders`. It is a side-effecting module, and `lib/monaco-loader.ts` is its only importer: `ensureMonaco()` pulls it in when the first `CodeEditor` mounts rather than at startup, and `CodeEditor` renders a placeholder until it resolves (#1146). That order is the requirement, not an optimisation - `loader.init()` running before `loader.config({ monaco })` sends the app to the CDN for a copy it already ships. Anything that needs the instance without wanting to load it (the `pm.*`, `{{variable}}` completion, `{{variable}}` hover, and script-type providers registered from `App`) subscribes with `useLoadedMonaco()`. That same composition also defines the app's Monaco theme (`vayu-light` / `vayu-dark`, #1321), because it has to precede the first `editor.create` - a theme name Monaco does not yet know falls back to `vs` and never revisits it, so registering later, from a React effect, would be too late for the editor that mounts first.

## Drag primitives (`lib/drag/`, `components/shared/DropIndicator.tsx`)

What a drag surface shares without sharing a DOM. The collection tree and the tab strip (`useTabStripDnd.ts`, issue #2039) both import them; the files sit outside `modules/collections/` so a surface imports them rather than copying them.

| File | Role |
|---|---|
| `lib/drag/drag-gesture.ts` | Press versus drag, and the trailing click. A pure state machine over pointer coordinates: below the ~4px threshold a press is still a click (the row opens synchronously, which the hit-area guards pin), and a completed drag swallows exactly one following click - the one that would otherwise open the row that was just dropped |
| `lib/drag/drop-slot.ts` | Where a drop lands in a one-dimensional list: `slotAt` (the number of items whose midpoint is before the pointer), `landingIndex` (the index the item ends up at once lifted out of its old place; a drop whose landing index equals the item's own is a no-op). Pure and node-tested; throws on a non-integer or negative index. The tab strip uses it; the collection tree does not - its drops resolve against a parent and an anchor row (`drop-position.ts`, `useTreeDnd.ts`'s `indexAmongSiblings`) |
| `components/shared/DropIndicator.tsx` | The 2px `--primary` line a drag draws at the edge it would drop on, `horizontal` (across a row, indented by `indentPx`) or `vertical` (down the side of an item, as in the tab strip). `aria-hidden`, `pointer-events-none`, and `data-drop-indicator` carries the edge. The host must be `relative`. The tree's `RowDropIndicator` delegates to it |

## Agent references (`lib/agent-reference.ts`)

The one place the app words an entity for an agent (#2046): `Vayu <kind> "<name>" (<id>)` plus a tail, one
exported formatter per kind (`requestReference`, `exampleReference`, `collectionReference`,
`environmentReference`, `runReference`, `runComparisonReference`, `inboxReference`, `captureReference`,
`mockServerReference`, `mockIssuerReference`, `trashReference`, `variableReference`, `specOperationReference`,
`graphqlOperationReference`, `runSampleReference`, `elementReference`, `thresholdReference`). **A reference carries no value:** each
formatter takes a `Pick<>` of exactly the fields it prints, so a URL, header, body, variable, token or
secret is not reachable from inside it, and a run's URL is cut to its path with `lib/path-label.ts`
(`pathLabel`, shared with the tab titles) plus a cut at any `?` or `#`. The module is pure - no React, store
or query import - so the caller resolves what a line names (a collection chain from
`collectionNamePath` in `modules/collections/tree-utils.ts`, a collection run's collection name) and passes
it in. The grammar and an example of every kind are in
[MCP: Naming what the user means](../engine/mcp.md#naming-what-the-user-means);
`agent-reference.docs.test.ts` fails when a line on that page stops matching the formatter's output.

The surfaces that put a line on the clipboard are the "Copy for agent" row actions (#2047): request, collection,
environment, history, inbox, mock-issuer and mock-server rows, the tab menu and the palette's
`copy-for-agent` command, each through `useCopy()` with the name "Reference" (toast "Reference copied"). A collection's line takes the chain *above* it and a request's the chain of its own
collection, so neither names a folder twice. The same line is on the surfaces that have no row menu:
a trash entry, an example row, a capture's detail header (the shared `CopyForAgentButton`), a variable row and a
run sample's header carry an icon button (`useCopy({ feedback: "icon" })` with `IconSwap`, so the glyph swaps to a
check and no toast follows), and the inbox and mock-server tab headers a text "Copy for agent" button (toast
"Reference copied"). The URL copy buttons beside it are icon buttons too (#2315).
A pipeline element row (`ElementList`) has a "Copy for agent" item in its `⋯` menu, after Duplicate, built from
the element's id, kind and name alone; the host names the owner through `referenceOwner` (the request builder's
Elements tab for a saved request, the collection's Elements tab for the collection) and the item is absent without
one. A variable row takes its scope from `VariableTableEditor`'s `config` and is absent for a secret row, an
unsaved row and a scope that is not loaded; the line is built from the name alone, so the value never reaches it.
A run sample's button (the shared `CopyForAgentButton`) is absent without the run id (`report.metadata.runId`) or the sample's result row id.
The next three are icon buttons too, drawn by the shared `components/shared/CopyForAgentButton.tsx`
(`reference` and `label` in, the glyph swap and the `size-control-sm` hit area inside): the GraphQL Query pane's
operation picker (`graphqlOperationReference`, named by the saved request - `BodyPanel` reads the saved row, as
`ExamplesPanel` does, so an unsaved rename never reaches the line - and passed to the lazy `GraphQLBody` as the
`operationReference` prop); each operation row of
the Spec tab's Sync report (`specOperationReference`, in the collection being synced, beside the row's label and
not inside it so a copy never ticks the row), and each budget (`thresholdReference`) - on the verdict card, of the
run (`runId`, from `report.metadata.runId`, absent without it), and in the load test dialog, of the saved request
(`referenceOwner`, absent in the collection runner, which has none). The dialog's six fixed fields carry it
through `NumberField`'s `action` slot, keyed by the payload's own key (`latencyP99Ms`); a custom row carries it
once it has a metric name, keyed `custom.<name>.<stat>` as `budgets.ts` sends it, and holds an empty slot of the
same width before that so the columns do not shift. Run coverage's operation rows (`ContractCoverage`) carry none:
the run's report names the spec but not the collection that holds the binding, which is an ancestor of the
collection that ran when the binding is inherited.

## Collections (`modules/collections/`)

| Component | Role |
|---|---|
| `CollectionTree.tsx` | Hierarchical tree of collections + requests in the sidebar; expandable folders, context menus, method badges. Layout and the panel chrome only - the reveal effects, the CRUD state and the shared row values each live in their own module below. The toolbar's Add request goes through `hooks/useNewRequest.ts` like every other "New request" entry point (remembered collection, else the only one, else the picker it renders), with one override: an open collection tab names the collection. With no collections it creates a default one and the request, rather than opening the new-collection form. State from `useCollectionsStore` + `useCollectionsQuery`/`useRequestsQuery`. It hands `useRovingTreeFocus` the visible rows as a `TreeRowModel` (`navigableRows`), so the keys walk every row rather than the mounted ones, and moving focus goes through the window's `revealRow` |
| `context/CollectionTreeContext.tsx` | Everything a row needs that is not the row itself, in **three contexts split by how often the value changes** (#2543), because every consumer of a context re-renders when its value does. `CollectionTreeHandlersContext` holds the functions plus the `dnd` slice (`useTreeDnd`'s, `null` where no drag machinery is mounted, which is what a test rendering one row gets): its identity holds across a keystroke and a pointer move, and it changes only when the collections a render-time function (`getCollectionActions`) describes do. `CollectionTreeStateContext` holds the tree's data (collections, the expanded set, the selection, the requests lookup) and the rename / delete / new-folder-open state. `CollectionTreeFolderDraftContext` holds the half-typed new-folder name and nothing else, read only by `NewFolderForm`. Rows read them through `useCollectionTreeHandlers()` / `useCollectionTreeState()` / `useCollectionTreeFolderDraft()`, each of which throws when a row is rendered without `CollectionTreeProviders` (`context/CollectionTreeProviders.tsx`, the one nesting the tree and the test helper share). The drag indicator (`dragging`, `dropTarget`) is deliberately not a context: it changes on every row the pointer crosses, so it is a zustand store on `dnd.dragState` that each row subscribes to with a selector, and a crossing renders the two rows whose answer changed. `CollectionTree.render-count.test.tsx` pins both with 300 mounted requests |
| `useRevealActiveSelection.ts` | The two once-per-selection effects that keep the active tab's row rendered and on screen: expand its ancestors, then scroll it into view. Separate refs, because the scroll can only run a render after the reveal. Also returns `revealEntity`, the imperative version a move calls: a move does not change the selection, so nothing in those effects would fire. Both scrolls go through the window's `revealRow` (below), never the row element: the row may not be mounted until the drawer has scrolled to it, and the window scrolls the drawer body alone where `scrollIntoView` would move every scrollable ancestor (#1612) |
| `useTreeDnd.ts` | The drag machinery: one set of pointer handlers on the `role="tree"` element (`treeHandlers`, #2543) - a press resolves its row from the rows model (`entityAt`), never from a handler on the row - plus pointer capture, hit testing, spring-loaded folders, auto-scroll, Alt+Arrow moves, the row menu's Move up / Move down / "Move to…" entries, the "Move to…" dialog state and the undo offer. Everything decidable without a DOM is delegated (`lib/drag/drag-gesture.ts`, `drop-position.ts`, `reorder-math.ts`, `useReorderMutation`), and all four ways a row can move go through one `applyPlacement` so the write, the announcement and the reveal cannot drift. The capture is the tree's, so a source row scrolled out of the window cannot take the gesture with it, and it is taken when the press becomes a drag rather than at the press: a captured press clicks the capturing element, and a click on a row has to land on the row's own controls. A press carried out of the tree before it is a drag is dropped (`onPointerLeave`), since without the capture its release never arrives. Every position is an index in the parent's merged sibling list (`childrenOf`): Alt+Up/Down step past a row of either kind, Alt+Right moves into the sibling directly above only when it is a folder, Alt+Left lands right after the parent, and "position X of N" counts both kinds |
| `tree-row-dnd.ts` / `TreeRowDnd.tsx` | The per-row half, shared by both row types: `useRowDnd` (drag/blocked/indicator state, no handlers since the tree holds them - each read from the drag store through its own selector, so a row renders only when its own answer changes - and the row menu's move entries - Move up, Move down and "Move to…", the chord-free reorder path added by #1690, off at the ends with the reason on the item), `rowDndClasses`, the 2px `--primary` drop line indented to the target's depth (`RowDropIndicator`, the horizontal case of the shared `DropIndicator`), and the four hidden `data-tree-move-*` Alt+Arrow controls |
| `MoveToDialog.tsx` | The row menu's "Move to…": a tree-ordered picker of every collection the row may move into, minus itself, its own subtree and the parent it already has. The row lands after every child of the destination, both kinds. The chord-free path to the same move |
| `useTreeCrud.ts` | Create, rename, duplicate and delete for the tree, with the inline form state each drives. Returns `panel` (what the tree's own chrome renders) and, for the contexts, `handlers`, `rowState` and `folderDraft`. The handlers a row calls from an event go through `hooks/useStableCallback.ts` (one identity, the latest render's closure) rather than a `useCallback` over a mutation object that is new every render - that is what keeps the handlers context from changing on a keystroke. Duplicate copies the whole source record - read through `requestDetailOptions`, since the row it was invoked on is a summary (#2546), then spread, never a hand-written field list, since a named list drops every field added after it was written (issue #1519) |
| `tree-rows.ts` | The tree as the rows a user can see (#2543): `flattenVisibleRows` lists them in order - the roots (orphans included, `treeRoots`), and under each expanded folder its new-folder form, the "Empty collection" line when it holds nothing, then its children as **one list**, sub-folders and requests merged in sibling order by `mergeSiblings` (#2535), so a request can sit above or between folders - each with its depth, its parent, its `aria-posinset` / `aria-setsize` over that merged list and a stable key. `rowSpacingAbove` is the gap above a row, read from depth alone; `rowKeysUnder` is a folder's visible subtree. It owns the row keys (`folderRowKey`, `requestRowKey`, `entityRowKey`, `newFolderFormRowKey`), each row's height and stride in spacing units (`rowHeightUnits`, `rowStrides`), the treeitems as the keyboard walks them (`navigableRows`), the rows kept mounted around the tab stop (`rowsAroundFocus`), and the entity a row stands for (`collectionEntity`, `requestEntity`, `rowEntity`), which the rows, the drag and the right-click menu all build through. Pure and node-tested, so what is on screen is decided without a DOM |
| `CollectionTreeRows.tsx` | Renders that list flat under `role="tree"`, one wrapper per row carrying the gap above it (`mt-0.5`, or `mt-1` into a folder), its height (`h-8`, `h-10` for the new-folder form, from `rowHeightUnits`) and the dimming of rows inside a folder being deleted. **Windowed** (#2543): only the rows in view of the drawer mount, through `useTreeWindow`, and each skipped run is one `aria-hidden` spacer of the same spacing units, so every mounted row sits where the whole list would put it. Some rows stay mounted wherever the drawer is scrolled: the row holding the tab stop (the last treeitem focus landed in, or the first treeitem before any has) with its neighbours from `rowsAroundFocus` - the rows focus steps to and the three a delete hands it to, remembered for a commit after that row leaves so the refocus still finds its successor mounted; the new-folder form and its folder; the row being dragged, so the source keeps its place and its dimmed state for the whole gesture (the capture is the tree's, so the gesture does not depend on it); and the row a reveal is bringing in. A row being renamed needs no pin of its own, since its field holds focus for as long as the rename lasts. The tree acts on a row through the `TreeRowWindow` handle this exposes: `revealRow(key, then)` scrolls the drawer to the row, mounts it if need be and hands `then` its treeitem once it is mounted - the keys, the selection reveal and the moved-row reveal all go through it - and `rowOf(element)` answers which row of the list an event came from, which is how the tree's one right-click menu and its drag handlers find their row. Memoised on the row array, which `CollectionTree` rebuilds only when what is visible changes |
| `useTreeWindow.ts` / `tree-window.ts` | The window: which rows the drawer body (`[data-drawer-body]`) can show plus ten rows of overscan each way, read from a passive scroll listener (one read per animation frame) and a `ResizeObserver`, in steps of 32 units so a scroll re-renders the list every few rows rather than every frame. Positions are a prefix sum over each row's stride in spacing units (`rowStrides`), binary-searched; the viewport is measured from the list's own top, so the toolbar's new-collection form above it is subtracted. `--spacing` is read on mount and on every resize (a density change resizes the list), falling back to 4px. **Everything mounts** below 100 rows and wherever nothing can be measured - no scroller, no `ResizeObserver`, or a scroller with no height - which is what jsdom is, so the tree suites render the whole tree as they always did and `CollectionTree.windowing.test.tsx` stubs the layout to get a window. This is fixed-stride windowing, not the variable-height kind `hooks/useGrowingWindow.ts` declines: every row's height is set by its wrapper from the same number the arithmetic reads, so there is nothing to measure and no scroll map to keep. `tree-window.ts` is the pure half (`rowOffsets`, `rowAt`, `visibleRange`, `mountedSegments`, `nearestScrollTop`), node-tested |
| `NewFolderForm.tsx` | The inline "new collection" form a folder row opens, a row of the list at its children's depth. The one reader of `CollectionTreeFolderDraftContext`, so a keystroke renders this form and no row |
| `CollectionItem.tsx` | A collection (folder) row, wrapped in `memo` (#2543): its props are its entity, depth, position in the sibling set and, when it is expanded and empty, the id of the placeholder it names in `aria-describedby` - all primitives or query-cache objects, and everything else comes from the contexts. It renders its own row only; its children are rows of the list. It mounts no menu of its own for right-click: the tree's one `CollectionTreeContextMenu` opens over it with the same list its `⋯` menu offers (issue #1360), both built by `collectionRowMenu`. The list is `useTreeCrud`'s `getCollectionActions` plus the drag slice's move entries, whose **Copy for agent** item names the collection with the chain *above* it. It carries the `own-menu` marker while it has a menu, and drops it with the menu while renaming or deleting |
| `RequestItem.tsx` | A request row (method badge, click → open in RequestBuilder), wrapped in `memo` like `CollectionItem` (#2543). Same prop rule as `CollectionItem`, and the same arrangement for right-click: the tree's one menu, built by `requestRowMenu` like its `⋯` menu. Its **Copy for agent** item words the request with the folders it sits in (`requestRowReference`: `collectionNamePath` over `allCollections` from the state context) |
| `tree-row-menu.ts` | A row's actions and its menu's name, for both menus that show them (#2543): `collectionRowMenu` (the CRUD list with the move entries spliced in before the destructive tail), `requestRowMenu` (Rename, Duplicate, Copy for agent, the move entries, Delete) and `treeRowMenu`, which answers for a row of the flat list and is `null` where a right-click opens nothing - not a treeitem, mid-rename or mid-delete, or nothing to offer |
| `CollectionTreeContextMenu.tsx` | The tree's one right-click menu (#1360, #2543): the `role="tree"` element is the only trigger, the row comes from the click through `TreeRowWindow.rowOf`, and the items are `treeRowMenu`'s, drawn with `RowContextMenuContent`. Decided in the capture phase, before the trigger's own handler: over a row with a menu it focuses the row (so Escape returns there), otherwise it stops the event short of the trigger and the platform keeps its default. The menu closes if its row starts a rename or delete while it is open. → `CollectionTree.right-click.test.tsx`, `CollectionTree.windowing.test.tsx` |
| `ImportModal.tsx` | Import collections from file/URL/paste (Postman / Insomnia / OpenAPI). Mounted globally in `Shell`; open-state in a dedicated store. Entry is per **file**: a multi-file drop or selection, or "Import folder" (`webkitdirectory`, recursed and filtered to `.json/.yaml/.yml`), previews as a **batch ledger** - one row per picked file with its detected format, counts, skip tally or error, and an include checkbox - and applies each file as its own `POST /import/apply`, so one refused file does not undo the others. One file renders the full preview tree instead, each collection's sub-folders and requests in the one order the sidebar will list them (`draftSiblings`: a Postman or JMeter file's document order, an Insomnia file's sort-key order, every other format's folders first, issue #2535); a file another picked document inlined as a `$ref` target is listed as such and never imported twice. A document a collection is already bound to forks before the apply into Sync or import-anyway (`SpecReimportDialog.tsx`, issue #680). **Each of the three tabs holds its own state** - phase, entries, error and progress (issue #893): they were one set for the whole dialog, and switching tab `reset()` them, which cleared the *display* of work that went right on running and then landed under whichever tab was showing when it finished. So a tab switch now only switches tabs, every async writer patches the tab it started on behind a per-tab generation counter that a close, a reset or an option toggle bumps, and the URL download carries an `AbortSignal` the close actually fires. The two option checkboxes stay dialog-wide, so a toggle re-parses **every** tab holding a parse rather than the visible one - otherwise the other tab keeps a parse made under the old options. A toggle bumps the generation before it re-parses (issue #895): a re-parse is an engine round trip per file and the checkboxes stay live for it, so two toggles inside one round trip would otherwise hold the same generation and whichever landed last would win the entries - importing a setting the checkbox says is off, since `importScripts` is baked in at parse time. They are the only writer that may be superseded that way, which is why the checkboxes close while an apply is in flight: it holds a generation captured before its first file went out, and its outcome write is what reports which files failed. A document dropped on the OS Dock or taskbar icon opens this dialog on that file (issue #1364): main carries the path in, the dialog reads the bytes back through the same gated `specFile:read` channel a `$ref` sibling uses, and one `BatchDocument` goes into the ledger a picked file goes into - a fourth *source*, not a fourth way to apply an import. A path that arrives while the dialog is already open is picked up the same way (issue #2275): a preview or read in progress is replaced and a toast says which file replaced it, and an apply in flight refuses the path with a toast, because superseding the File tab would drop the outcome write that reports which files failed. The packaged macOS app declares the three extensions as `Viewer` at rank `Alternate`, so it is offered in Open With and never becomes the default for `.json`. A Postman import that resolved client-certificate candidates lists them in the footer through `ImportClientCertificates.tsx` (host, port, certificate path, key path; never the passphrase), one unticked checkbox each, kept per batch entry as `BatchEntry.selectedCertificates`: only the ticked ones reach `POST /import/apply`, and the rest are tallied in the `certificate` notice (issue #2363). See [import-collections/](./import-collections/README.md) for the batch layer and the parser pipeline |
| `ImportClientCertificates.tsx` | The footer section of `ImportModal` that offers a Postman import's client-certificate candidates for registration (issue #2363). One checkbox per candidate, unticked by default; absent when no applicable file lists any. A registry row is host-wide and outlives the import, so nothing registers unless ticked |
| `import-notices.ts` | What a parsed file lost or changed, as the lines the import preview and every batch ledger row show - one line per kind, never joined into a sentence. Each `meta.skipped` kind has a tier: **amber** when a request will not work as imported or something sent is missing, **muted** when the import made a choice, and **not shown** when nothing the user sends changes (`default` responses, a Postman URL assembled from `host[]`/`path[]`); still counted in `meta.skipped` either way. A count the engine could tie to requests names them (`Upload an image: body not imported (binary file)`, or `3 requests: ... - A, B, C, +2 more`), so the user knows which request to open. `meta.unsupportedScriptApis` (a Postman script that uses an API Vayu does not run, #2576) is its own amber line, `Sign in: script uses APIs Vayu does not run yet (tests[], CryptoJS)`: the requests named as above, the API names a deduplicated union cut at four. It is the one notice with a `link` (`{ label, key }`, an `openAppLink` key), to the "Not (yet) supported" section of `pm-api-compatibility.md`. A JMeter class with no words of its own reads as its class name, never a slug. Its `describeCounts` is the one count line under a file (`1 request · 3 nested collections · 0 examples`), pluralised and shared by the single-file preview and the batch rows: examples always (0 is an answer, #481), environments and globals only when non-zero, and a file with no requests or nested collections that carries either reads as just those (`1 environment`). Its `describeCarriedOver` is the single-file preview's second line (`Carried over: 12 variables · auth on 40 requests · scripts on 8 requests`, #2249), read off the drafts: zero segments are left out and a file with none shows no line |
| `NoticeList.tsx` | The lines `importNotices` writes, drawn: amber (the `Callout` warning text) for what the user finishes by hand, muted for what the import decided, neither announced as an alert. A notice's `link` draws as a `link`-variant `Button` at the end of its line that asks the main process for the keyed docs page (`window.electronAPI.openAppLink`, see `electron/app-links.ts`), also inside a batch row's `<label>` without toggling its checkbox. Also exports `NoticeLine`, the one line `ImportFileFolders.tsx` draws its file-reference follow-ups with. Shared by the single-file preview and every batch ledger row (`as="span"` inside a row's `<label>`) |
| `import-report.ts` | What an import does once it is applied (issue #2109): `buildImportReport` keeps one file's notices, file-reference needs and counts, and `announceImport` records them in `import-report-store`, expands the new roots, opens the first as the active tab and raises one toast - `Imported "Pet Store" - 60 requests, 4 nested collections; 2 things to finish.` - whose single action opens the collection on its Info tab when there is a report (the environment outcome of #2115 then rides in the message alone, see `import-environment.ts`), and otherwise is the environment outcome's own action if it has one; the Info-tab open works even from another sub-tab of the same collection (`CollectionDetail` reads `tab-selection-store` for the selected collection rather than only seeding from it) |
| `import-environment.ts` | The active environment after an import (issue #2115): `planEnvironmentActivation` decides from the environments the batch created and the engine's list, `activateImportedEnvironment` carries it out and returns the outcome `announceImport` folds into the toast (`; "Staging" is now the active environment`). The outcome's action - **Use "Staging"**, or **Choose environment**, which opens the title bar menu through `env-switcher-store` - takes the toast's single action slot unless **Review import notes** holds it |
| `tree-utils.ts` | Every `parentId` walk in the renderer: `walkAncestors` (the ancestor chain, root first), `collectionPath` (the "Payments / Auth" label the palette and the new-request picker show), `isDescendant`, `collectDescendantEntityIds` (what a cascade delete reaches), `countSubtreeRequests` (the requests anywhere under a folder, which a root row's count shows). Each carries a visited-set termination guard - the engine tolerates cycles in stored data, and an unguarded walk hangs the window rather than answering wrongly. Also used by `queries/collections.ts` and `useVariableResolver` |
| `tree-children.ts` | `childrenOf(parentId, ...)`: a parent's sub-folders and requests as the one list the tree shows them in, sorted by `compareTreeOrder` with each row's kind stated (#2535). The top level holds collections only. `mergeSiblings(folders, requests)` is the merge itself, for a caller that already holds both lists: `flattenVisibleRows` indexes the folders by parent once per build rather than filtering the whole list per expanded folder. The render, the drag, Alt+Arrow, the menu's Move up / Move down gating, "Move to…" and the reorder mutation's optimistic renumber all read one of the two, so none merges the two kinds itself |
| `drop-position.ts` | Where a drop lands: 25/50/25 bands on a folder row, 50/50 on a request row, resolved to a parent plus an anchor row. A parent's children are one list, so a request lands between two folders and a folder beside a request; the one refusal by kind is a request on a root folder's edge band, since the top level holds collections only. Returns a parent + anchor, never a pixel position |
| `reorder-math.ts` | The arithmetic behind a drop: `planMove` turns a parent's merged sibling list and a target index into the `POST /reorder` batch, writing only the rows whose position changes - each as its own kind - and normalizing (`{ parentId }`) a parent whose rows are not dense. Pure and node-tested - the part of a drag a jsdom gesture cannot reach. Consumed by `useReorderMutation` |
| `CollectionDetail/` | The collection editor screen (see below) |

### `CollectionDetail/` (screen `"collection-detail"`)

Tab shell reached via `navigationStore.navigateToCollection(id)`. Header shows name + request count, and - right-aligned - the mock-server control; six tabs:

The **request count is the whole subtree**, not the requests the collection owns
directly, and the shell computes it once for both the header and the Info tab. A
spec-bound root usually owns none directly - an OpenAPI import files them under
one sub-collection per tag - and every other surface on this screen already means
the subtree: the mock serves it, the Run dialog runs it, the export walks it, the
Spec tab counts it.

| Tab | Component | Notes |
|---|---|---|
| Info | `InfoTab.tsx` | Name, description, request count (the shell's subtree count, handed down). **Autosaves** - no Save/Cancel. Opens with `ImportNotesCallout.tsx` when an import recorded a report for this collection (issue #2109): the preview's notice lines and file-reference list from `import-report-store`, with a dismiss button; nothing otherwise |
| Auth | `AuthTab.tsx` | Collection-level auth (concrete; never `inherit`). Mode picker + hints only - the fields are the shared [`AuthFields`](#shared-auth-fields-componentssharedauthfields). **The one tab with a Save button**, and it says so above the fields |
| Elements | `ElementsTab.tsx` | Extractors, assertions, timers and scripts on the collection, through the shared [`ElementList`](#shared-elementlist-componentssharedelementlist) primitive (issue #1512). Replaces the Pre-request and Post-request tabs - a script is now a `script.pre` / `script.post` element like any other kind, edited by the same list. **The one other tab with a Save button** beside Auth, and for the same reason (#446): adding a kind, naming a row, toggling it, reordering it and editing its form are all separate focus stops, not one buffer a blur can commit |
| Variables | `VariablesTab.tsx` | Collection-scoped variables (count badge) |
| Data | `DataTab.tsx` | The declared **data contract** (issue #599): pick a file and its columns are declared onto `collection.dataSchema`, **Remove** clears the contract (the picker's `onRemove`, distinct from a refused pick's `onSelect(null)`), **Re-declare** / **Clear** cover drift, a failed save and a vanished file, plus the **referenced-columns audit** (`ColumnAudit.tsx`, issue #600). Declared-column count badge. Writes per gesture, through the shared `hooks/useDataContractWriter.ts` (declare and clear; the remembered path is written only once the engine accepts the schema), so it holds no draft and is absent from `TABS_HOLDING_DRAFTS` |
| Spec | `SpecTab.tsx` | The bound **OpenAPI document** (issue #638): where it came from, its short hash, when it was fetched and bound, and how many of the subtree's requests carry an operation identity. Binds a collection that was not imported from a spec - match by method and path shape, counts disclosed, matches stamped and nothing else touched - **Unbind** sends `openapi: null`, and the **Export** menu opens either export dialog - **OpenAPI…** (issue #630) or **Postman Collection v2.1…**. The **Sync** section (`SpecSync.tsx`, issues #654 and #655) re-reads the document from the URL or file the binding recorded, reports what moved in three buckets, and applies the items the user ticks in one engine call - checking still writes nothing, and a removal is never ticked for you. Explicit per action, so it is absent from `TABS_HOLDING_DRAFTS` like Data |

`MockServerControl.tsx` is the header's right-hand control and the only surface that can **start** a
mock server (issue #481 phase 2), because it is the only one holding a collection. With none running
for this collection it is a **Run mock server** button; with one running it is a chip carrying the
base URL, the route count and how many of those routes have no example, plus copy, an **Open mock
server** link to the `mock-server` tab and stop. It picks
its mock by `collectionId` and, when several match, by the **lowest port** - nothing stops a user
starting two mocks of one collection, and the engine's list order is not stable across polls. There
is deliberately no restart: a mock's route table is a start-time snapshot, so stop-and-start is the
only way to pick up an edit, and the stop tooltip says so.

Beside the button, not in front of it, is a **Mock server options** control opening
`StartMockServerDialog.tsx` - the start form for `latencyMs` and `errorRatePct` (issue #570). The
split is the point: the common case is "serve this collection with nothing set" and stays one click,
while the two knobs matter to the load run you point at a mock rather than to poking a route by
hand. A dialog on the way in would charge the common case for the uncommon one;
[`NewIssuerDialog`](#services-modulesservices) has no equivalent split because an issuer has no
defaults-only case worth one click. The bounds (`0-30000ms`, `0-100%`) live in
`mock-server-options.ts` mirroring `constants::mock_server::`, and the form refuses an out-of-range
or emptied value **with the range in words** - the engine's `400` names the field and not the bound.
The same dialog carries the **Allowed origins** box (issue #2367, `AllowedOriginsField`), sent only
when something is listed.
The mutation stays in `MockServerControl` and the dialog reports its failure as a `Callout` instead
of a toast behind an open form; opening the dialog resets it, so a failed one-click start does not
greet the next open. Neither knob is mutable on a running mock: they are read per response and so
*could* be, but a run against a mock has to be able to say which configuration produced its numbers
- the same reason the route table is frozen - so there is no `PUT /mock/:id` and the stop tooltip
names all three as start-time.

`InheritanceChain.tsx` and `shared.tsx` are helpers used by these tabs (e.g. visualizing the auth/variable inheritance chain); `format.ts` holds the relative-timestamp helper, kept out of `shared.tsx` so a file of components exports nothing else (fast refresh). `AuthTab` passes it the tab's own live draft (`draftAuth`), so the chain shows the picked-but-unsaved mode instead of the stored one while the picker is dirty (#1483) - the same draft `CollectionAuthSection` above reads through `useCollectionAuthDraft`. This collection's row (and the No auth sentence, when it is the blocker) reads "(unsaved)" while the draft differs from the stored auth.

All five tabs hold their edits in a draft; four of them commit it without being asked. Info commits on blur (name) and on `onCommit` (description); both Script tabs commit when focus leaves the editor; Variables autosaves through `VariableTableEditor`. Info and the Script tabs take the draft, the resync and the mutation reset from [`useEntityDraft()`](./state-management.md#useentitydraft---manual-draftsave-model) and render no Save button at all - the hook owns the mutation reset on a collection switch, which had been hand-rolled per tab with one tab omitting it.

**A dirty draft can show "Changed elsewhere" instead of losing an edit (#1437).** An MCP agent's `update_collection` landing while Info, a Script tab or Auth is mid-edit no longer overwrites the unsaved text: the shared [`ExternalChangeCallout`](#shared-external-change-callout-componentssharedexternalchangecallouttsx) renders the notice with a "Take theirs" action, driven by `useEntityDraft`'s `externalValue`. Auth and the Script tabs treat their draft as one value, so the whole tab shows one callout wired to `reset()`. Info's draft is `{name, description}`, so it merges per field instead - a field the user has not touched adopts the agent's change immediately, and only a field both sides touched shows its own callout. Its Take theirs calls `adopt`, so taking the value is a discard the Dock reports as idle, not "Saved" (#2033).

Info's blank-name rule survives the buttons' removal by being spoken instead: `reportBlankNameRefused()` (`lib/blank-name.ts`) puts the stored name back and reports through `failSave`, the same channel and the same wording the request builder's Info tab uses. The Script tabs' `Clear` writes on the press rather than waiting for a blur that is not coming - focus lands on the button, not in the editor.

**Auth is the exception, and it is a decision (#446), not a leftover.** Not because a credential outranks a script - the request builder autosaves its own auth - but because a blur inside `AuthFields` is not a completion signal. Measured on this tab: an OAuth 2.0 config with Advanced open renders 20 focus stops, 9 of them non-value controls (the grant-type and Add-to pickers, three switches, the secret reveal toggle, the Advanced disclosure, Get Token), and clicking reveal to check a half-typed password fires `focusout` while the draft is dirty. The fields only make sense written together, which is what the button means. A script tab has exactly one focus stop. Because the tab therefore differs from its neighbours, it states its save model above the fields rather than only through a button further down the page. If collection auth is ever to persist by itself, the mechanism is `useSaveManager`'s debounce, not a blur.

## Load Test Dashboard (`modules/dashboard/`)

Live load-test metrics. Entry: `modules/dashboard/index.tsx`.

Connects to the engine SSE metrics stream (`/runs/:runId/live`, via the load-test service / dashboard store), shows live metrics while running, and converges on the final report on completion. Stop action supported. A run that finishes any way at all - `completed`, `failed` and `stopped` alike (issues #1932, #2136) - renders History's own [`LoadTestDetail`](#history-moduleshistory) over its report once the report has arrived (issue #2220), so the same run shows the same numbers, labels and verdict here as when it is reopened from History. Above it the dashboard keeps only an identity row (Back and the status pill with the run's outcome) and the stream-error callout; the crumb, the request line, the configuration and the "Not judged - Stopped before it finished" verdict are the report's own. Until the report arrives (a stopped run's, which the Stop click precedes, or one whose fetch failed) the live layout stays, with the "Couldn't load the run report" Retry. The live view has no tab bar.

The dashboard is **mode-adaptive**: a `useMode()` discriminator maps the run config to one of `constant_rps` / `constant_concurrency` / `iterations` / `ramp_up`, and the hero row + stat row + charts render the surfaces appropriate to that mode. `MetricsView` is a thin orchestrator over a modular tree:

While a run streams the app can hold a system wake lock, so the OS does not
suspend the machine under a test the user walked away from (issue #1357). It is
off by default and turned on either standing (Settings > Load testing) or per
run: a load run of ten minutes or more asks once as it starts, through
`components/shared/KeepAwakePrompt.tsx`, which is mounted at the app root
because the question is about whichever run is streaming rather than about the
surface that started it. The
lock is a request, not a guarantee - a closed lid overrides it - so a suspend
that happens anyway is marked on the time-series charts at the point the run
reached, labelled with how long the machine was gone. The record is the app's
own (`stores/host-sleep-store.ts`, keyed by run id): the engine was suspended
too and its report has no field for it.

A run reaching its end also posts a system notification when the user has
opted in and Vayu is not the window in front (issue #1358).

The run's progress is also mirrored onto the OS chrome: the Windows taskbar
button and the macOS Dock icon fill as it advances and clear when it ends, and
a failed run flashes the taskbar's error state on Windows, which macOS has no
equivalent of (issue #1362). Linux paints nothing - Electron 44 dropped Unity
launcher support. A collection run now fills too, from the size the engine
publishes on its stream as the run opens (issue #1398), and stays indeterminate
only where that frame never reaches the client - an older engine, or an attach
after the frame left the run's retained ring.

**Top-level (`components/`)**

| Component | Role |
|---|---|
| `DashboardHeader.tsx` | Run status, method and URL, stop button, and the config summary line (virtual users, mode, a data-driven run's row count and the file it came from, elapsed). A collection load run has no URL, so the collection's name and its step count ("Checkout · 12 steps") take that place (#2270); they arrive as the primitive props `collectionName` / `stepCount` from `hooks/useCollectionRunTarget.ts`, which reads the run's row (its snapshot's scenario manifest) and resolves the name from `useCollectionsQuery`, falling back to the id once the collection is deleted. The run's comment is the `comment` prop, drawn under that line by the shared `RunComment` ("Comment" label, one truncated line with the full text in its `title`): from the launch config while live, from the report's `configuration` once the run has finished - the report body no longer draws it, so this header is where a finished dashboard run shows it. Once that report is on screen the dashboard also hands the header `exportRunId`, with the report's `requestUrl` / `requestMethod` as `exportRequestUrl` / `exportRequestMethod` (primitives, for the memo), and the header draws the run's **Export** menu ([`RunExportMenu`](#history-moduleshistory), #2139) where the live header has Stop; a streaming run never mounts it |
| `MetricsView.tsx` | Orchestrator - composes the hero row, stat row, and charts per mode |
| `shared.tsx`, `tooltips.tsx`, `format.ts` | Shared bits (Eyebrow/InfoChip) + centralized InfoChip wording + the `orDash()` / `fmtRate()` helpers (their own module so `shared.tsx` exports only components; `orDash(value, formatter)` runs a shared formatter from `lib/format-number.ts` and draws "-" for a missing value, which the formatters alone would print as a measured `0`; `fmtRate` is `orDash` with `formatRate`) |

**`hero/` - mode-adaptive hero cards** (`HeroRow.tsx` selects per mode, all built on `HeroCardShell.tsx`): `RateFidelityCard`, `DroppedRequestsCard`, `AchievedThroughputCard`, `ThroughputCard`, `ThroughputTwinCard`, `CurrentConcurrencyCard`, `ConcurrencyUtilCard`, `SaturationCard`, `ProgressCard`, `ErrorRateCard`, and `LatencyPercentilesCard` (p95 and p99 with mean/median beneath, all over the run so far while it is live - the tick's `cumulative_p*_ms`, the span the mean covers, where the tick's own `latency_p*_ms` are only its last ~100 ms window - and the report's once it ends; each figure and its unit from `formatLatencyParts` so 1234 ms reads `1.23 s`; added by `HeroRow` for the throughput-led modes - `constant_rps`, `constant_concurrency`, `iterations` - which therefore carry no p99 stat; `ramp_up` and `capacity` keep theirs as p99 at peak in the stats row). Throughput on these cards prints through `formatRate`, so 3940 reads `3,940`; virtual-user counts go through `formatNumber` (10000 reads `10,000`), percentages through `formatPercent` (one decimal: `94.0%`) and seconds (the ETA, the ramp span) through `formatSeconds`, which carries its unit, so no card writes an `s` beside the number. `SaturationCard` prints the breakpoint p99 with `formatLatency`, the same figure the chart breakpoint line's hover shows. The closed-loop count reads "virtual users" on every card ("Active virtual users", "Virtual user utilisation", "Throughput per virtual user", "Peak virtual users"); under `constant_rps` the same series counts requests, so that mode's stat says "Peak in-flight requests". `isClosedLoopMode` and `concurrencyMeasureLabel` in `constants/load-test-modes.ts` make that call, and the card components and their props keep the `Concurrency` identifiers. `ConcurrencyUtilCard` paints neither its number nor its bar with a tier: idle virtual users describe the run's shape, not a failure, so healthy 40% utilisation is not red (#2245).

`ErrorRateCard` shows the engine's one error definition (issue #2124): a response outside 2xx/3xx, or no response at all; a 3xx is a success and is drawn in the green `2xx/3xx` segment. Its percentage is `failedRequests / totalRequests`, and the card is told the split rather than recounting it: the legend's **HTTP errors** and **No response** come from `DashboardDerived.httpErrors` / `noResponse`, read off the live tick (`http_errors`, `no_response`) or the report's `summary` by `utils/errorBreakdown.ts`. Its status bar buckets `DashboardDerived.statusCodes`, which `MetricsView` takes from the latest tick's `status_codes`, so the bar fills during the run instead of staying empty until the report loads; a finished run's card reads the report's distribution through `reportToDerived`. The report (`history/main/components/OverviewTab.tsx`) prints the same two words beside "Total errors" in the shared [`ErrorSummary`](#error-summary-componentssharederrorsummarytsx), fed `httpErrors` / `noResponse` from the same split. The card's colour follows the digits it prints: red for any rate above zero, success for a printed zero. A rate under 0.1% takes a second decimal (`0.01`), and one that rounds to nothing even then reads `<0.01`, through `formatErrorPercent` in `utils/format.ts`, so a nonzero rate is never `0.0` in red. A request cancelled by a user Stop (issue #2136) is not an error and is in neither the rate nor the bar: the engine keeps it outside `totalRequests` and the status-code distribution, and reports it as `summary.cancelledRequests`. The report says so in one muted line, "N requests cancelled by Stop", from `components/shared/CancelledRequestsNote.tsx` (silent for zero and for an engine that predates the count), placed outside the error card so a stopped run with no errors still shows it.

**`charts/`** - all time-series, scatter, and distribution plots are centralized in **`charts/uplot/`** and built on a single Canvas primitive, `UPlotChart.tsx` (uPlot). Import them from `charts/uplot/index.ts` so live and history render identical components: `LatencyPercentilesChart` (p50/p95/p99 of each second: a gate frame's `second_p*_ms` live and a stored tick's own `latency_p*_ms` in History, with no point for a live frame between gates, a `null` point (a break in the line, never 0 ms) for a second in which nothing completed, #2386, and the worst second of the bucket at a chart interval wider than a second; all read through `utils/tickPercentiles.ts`, #2385; drawn `muted` / `categorical-2` / `categorical` and never with a status role, because which percentile a line is carries no verdict; `percentile-series.test.ts` guards it, #2245; it also draws the SLO as a horizontal `subtle` marker, `SLO 200ms`, at the breakpoint's own `sloMs` or else the `sloThresholdMs` setting, whether or not p99 crossed it, #2698), `LatencyBreakdownChart` (two series, "average latency (incl. queue wait)" and "wire time", with the queue-wait gap shaded between them; both are the mean over the tick's trailing second, `window_avg_latency_ms` and `window_avg_queue_wait_ms`, never the run-cumulative `avg_*`, and a tick whose window completed nothing or that was stored before the window existed adds no point, #2393), `RequestRateChart` (throughput, the tick's `current_rps` over its trailing second, beside the send rate, `current_send_rate`, drawn only when some tick carries it so a run stored before the window existed never plots the cumulative `send_rate` under that label; configured-vs-achieved concurrency on a ramp, #2393), `ConnectionsChart` (the run's concurrency series, named by its `mode`: virtual users, or in-flight requests under `constant_rps`), `ErrorRateChart`, `ServerVitalsChart` (scraped server metrics joined onto the run timeline) (from `TimeSeriesCharts.tsx`); `ResponseTimeVsConcurrencyChart` (ramp_up capacity discovery w/ breakpoint marker) and `HdrPercentileChart` (from `ScatterAndDistribution.tsx`; its p50/p95/p99 markers, built by `hdrMarkers.ts`, are `muted` / `categorical-2` / `categorical` and take `warning` (p95) or `destructive` (p99) only past the optional `sloMs` prop, which `PerformanceTab` feeds from the `sloThresholdMs` setting, #2263); `StatusCodesOverTimeChart` (stacked: it plots running totals so the bands stack, and passes each class' own rate as `tipValues` so the tooltip reads "responses" over a per-second figure for each class, with a class that had none in the hovered interval left out, #2143; `buildStatusOverTime` divides each interval's count by the time it closes, so a live half-second bucket, a stored second and a History bucket of many seconds all read in responses per second, #2547; a live window whose head is not at load start drops its first point, which has no predecessor to diff against); and `CustomMetricsChart` - a `metric.record` / `pm.metrics` run's declared trends/counters/rates, one series per name (a trend plots its p95, a counter/rate its one value), cycling the same categorical palette `ServerVitalsChart` does since neither chart has a semantic mapping for a run-chosen name (issue #1579). Supporting modules in the same folder: `buildData.ts` (series → uPlot data), `chartFocus.ts` + `syncKeys.ts` (scatter↔time cross-highlight/cursor sync), `plugins.ts`, `formatters.ts`, `uplotTheme.ts` (CSS-token-driven theming), and `legend.ts` (`LegendEntry`: the label, role and swatch shape each chart module declares for what it draws, as `THROUGHPUT_LEGEND`, `LATENCY_LEGEND`, `PERCENTILE_LEGEND` and `SCATTER_LEGEND` (the `slo` entry of the first and last is one shared definition, and in `PERCENTILE_LEGEND` it names a marker, not a series), plus the lists a card renders: `LATENCY_ENTRIES`, `PERCENTILE_ENTRIES`, `SCATTER_ENTRIES` and `throughputLegend`). `MetricsView` and History's Performance tab render those lists through `charts/ChartLegend.tsx`, which paints each swatch through `ROLE_TOKEN`, so a card's key is built from its series' roles and never written by hand (#2311, #2697; `MetricsView.legend.test.tsx`, `PerformanceTab.legend.test.tsx`). History keys the request-rate, percentile and ramp_up scatter cards, the three the live view keys that History also draws; its request-rate key never names a target or the ramp pair, because History's chart is told neither. `plugins.ts` carries the overlay layer `UPlotChart` registers for every chart, `overlaysPlugin`: it pins single values (`Marker` - the capacity breakpoint, the target RPS, the SLO) and shades spans (`Annotation` - the detected anomaly windows, drawn under the markers so a dashed rule stays legible over a band). It is one plugin because the vertical labels of both lists share one layout (`labelLayout.ts`, #2696): each takes the first of two lanes under the plot's top edge where it clears the labels already there (markers first), and a label that fits neither is not drawn - its rule or band still is, and an annotation's full text stays in the hover tooltip. The time-series wrappers take the domain shapes (`breakpoint`, `anomalies`) and map them onto those chart-layer ones, so a caller never assembles a marker or a band by hand. The breakpoint's vertical line is labelled `p99 > SLO <sloMs>` (the threshold, never the observed p99) and carries the observed p99 and the load at the crossing as its `hover`. It is drawn on every time chart for a `ramp_up` run, on `LatencyPercentilesChart` alone for any other `mode` (so `LatencyPercentilesChart` and `ErrorRateChart` take `mode` as the other two do), and on none when `Breakpoint.atRunStart` says the run's first whole-second reading was already over the SLO, where the horizontal line says it better (#2698). The primitive's y scales start at zero (`yMin`, default 0; `yRange.ts`), so a series wobbling around 500 does not fill the plot and read as a collapse, and data below the base moves the floor down rather than being clipped; `ServerVitalsChart` and `CustomMetricsChart` pass `yMin={null}` to keep uPlot's auto-range, because their values are in the target's or the script's own units and may be negative. The secondary axis is labelled through `y2Label`: `RequestRateChart` names the ramp overlay's axis with `concurrencyMeasureLabel(mode)` ("Virtual users"), so it takes the run's `mode`. A horizontal marker whose value is outside the visible y range (an SLO the run never approached) is drawn pinned to the plot's top or bottom edge with " (above range)" / " (below range)" appended to its label, shortened to fit the plot; a vertical marker off the plot is still skipped, since that is the user zooming past it. Hovering a shaded `Annotation` adds its label to the tooltip (an instant is reachable within a few pixels; an annotation with an empty label is not listed). A vertical `Marker` with `hover` text is listed the same way within a few pixels of its line; one without is not hoverable. Outside `uplot/`, `HdrPercentilePlot.tsx` is now just the skeleton (`SkeletonHdrPlot`) and `TimingWaterfall.tsx` an SVG chart; the live `MetricsView` draws both in their empty state, since the report that fills them replaces the live view. Two plain-DOM readouts render in History's Performance tab: `PhasePercentiles.tsx` (per-phase percentiles over every completion) and `StreamMetrics.tsx` (issue #576 - what a streaming run's transfers delivered: events/sec, the per-completion event distribution, and how many streams a cap ended rather than the server). Both render `null` when their report section is absent, which is every non-streaming run for the second - the engine omits the section rather than zeroing it, so a card claiming an event rate of zero is a state the dashboard cannot reach.

**`stats/`** - `ModeStatsRow.tsx` routes to the per-mode Row 4 stat set (three cards for the throughput-led modes, four for `ramp_up` / `capacity`); `ModeStatCards.tsx` (its latency stats pass the `unit` of `formatLatencyParts` to the card, so the unit follows the value into seconds), `StatCard.tsx`, `LatencyStat.tsx` (one figure of the HDR plot's footer, shared by `MetricsView` and the History Performance tab; value and unit from `formatLatencyParts`, so a tail past a second reads `1.23s`), and the seconds-valued stats (Duration, Elapsed, Remaining) go through `formatSeconds`, which carries its unit, so those cards pass no `unit`. Latencies, rates and percentages in the run cards, the History header tiles, `LatencyMetric`, the step table, the baseline comparison and the chart value formatters in `charts/uplot/formatters.ts` go through `formatMs` (or `formatLatency`, which adds the unit), `formatSeconds` (a span in seconds), `formatRate` and `formatPercent` in `lib/format-number.ts`, beside `formatNumber`, so one value prints one way (issue #2217). A measured latency under 0.01 ms prints `<0.01`, not `0` (#2243). The axis tick formatters stay compact, but `axisMs`, `axisRate` (`/s`) and `axisVitals` (`k` / `M` / `G`) label each tick with its unit and pick their decimals from the whole tick array (`UPlotChart` passes `yFormat` the splits), so a 0 to 3 ms axis reads `0ms 0.5ms 1ms 1.5ms` and a rate axis over 1200 to 1220 reads `1.2k/s 1.21k/s 1.22k/s` rather than a run of repeated numbers.

**`hooks/`** - `useMode.ts` (run-config → mode discriminator).

**`utils/`** - `metricsTransforms.ts` (SSE history → chart series, including `buildCustomMetricsOverTime` for a run's declared custom metrics), `reportToDerived.ts` (stored `RunReport` → the same `DashboardDerived` shape, so history reuses the live components), `computeBreakpoint.ts`, `tickPercentiles.ts` (the one reading of a tick's percentiles: `secondPercentiles` per second, `cumulativePercentiles` for the run so far, #2385), `detectAnomalies.ts`, `computeEta.ts`, `chartGeometry.ts`. `types.ts` holds the shared dashboard types (`DashboardDerived`, etc.).

`detectAnomalies.ts` names the run's degradation windows. It is derived once per view - `MetricsView` for the live buffer, `LoadTestDetail` for a stored run - and passed down, so no card or chart re-derives it. The rules, the two entry points (a pure one-shot for a series that arrives whole, an incremental detector for a buffer handed over on a timer) and the invariant that keeps them in agreement are in `app/src/modules/dashboard/README.md`.

## History (`modules/history/`)

Past runs (single executions and load tests), split into a sidebar list and a main detail view.

**Sidebar (`sidebar/`):** `HistoryList.tsx` (filter/sort all runs; state from `useHistoryStore`, data from `useRunsQuery`; search, type, status, origin and pinned are asked of the engine so they reach runs older than the loaded pages, and only the MCP-client narrowing and the sort are client-side) and `RunItem.tsx` (one run row - status glyph, method badge, request name or URL, load-test chips; the start time and the status word are the row's time card, on its stretched activator). A **finished load run's** row also says how it went (#2130): its glyph is refined by the verdict (`rowOutcome`, from `resultSummary.verdict` and `.errorRate` alone - the tick only for a run that passed, a ringed exclamation for failed, a ringed question mark for not judged), a result line under the identity ("485 req/s · p95 42ms · 0.0% errors", each figure left out when the run did not record it) and the verdict in the activator's accessible name. The run's **comment** is a visible line of its own (two lines at most) for every run type, not a row of the time card: it is what tells two runs of one URL apart, and a hover is the wrong place for that. Right-click opens the row's pin/delete actions through `RowContextMenu` - a second route to the same hover-revealed handlers, since a history row had no menu at all before issue #1360 - plus **Copy for agent** (`runReference`, #2047), which has no hover-revealed button to mirror and is the menu's own.

**Who started a run** (#1817) is two marks on the row and one Select in the filter row. The engine records `origin: {kind: "app"|"mcp"|"other", client}` on every run (the renderer stamps `app` in `apiService`'s four run-starting calls, the MCP server stamps `mcp` with the client's handshake name). A run whose `requestId` is null and that is not a collection run (`type: "scenario"`, or a scenario load run, which carries `summary.scenario`) shows **Unsaved**: it came from a tab that was never saved, or from an agent that sent the request inline, so there is no request to open it from. A collection run never links a request, so it is exempt. An agent's run (`origin.kind === "mcp"`) shows a neutral chip with the client's product name from `mcpClientDisplayName` (`lib/mcp-client-names.ts`), the raw identifier when the table does not know it, and "MCP client" when the agent sent none; the app's and `other` runs show nothing, and the chip is in the activator's accessible name. Both marks are their own `shrink-0` elements beside the identity span, which stays the only thing that gives way. Every spelling in the table is one a client was seen to send, read from the client's source or from the community registry of `initialize` requests (apify/mcp-client-capabilities, snapshot 2026-10-06), and none is captured from a client talking to Vayu (the file's header says which row rests on what; #1819 stays open for the captures and for whether each client echoes `Mcp-Session-Id`). A wrong row costs a raw label rather than a wrong name. The third **Select** (All origins / App / Agents) sends the kind as `GET /runs?origin=` and re-applies it in `filterRuns`; once the loaded runs name more than one agent, each client is an entry under Agents too, narrowing client-side. "Clear the filters" resets the origin with the rest, and an origin that empties the list counts as a narrowing filter for the empty-state copy.

The filter row also carries a **Pinned** toggle, and it is the only filter that changes what is *fetched* rather than what is shown: it drives `GET /runs?baseline=true` (see `useRunsQuery`), so a pin old enough to sit past the loaded pages is still findable - which is the whole point of a filter for pins. It is applied a second time client-side, because unpinning patches the loaded pages in place instead of refetching them; without that pass the row just unpinned would linger in the pinned-only list until the next poll.

Every run's row carries the pin: a Pin action beside Delete (`useSetRunBaselineMutation` → `PUT /runs/:id/baseline`), on the row itself and in its right-click menu, and once pinned a chip that stays visible rather than appearing on hover - the pin is state, not an affordance. Only a load run's pin is also its request's **baseline** for the vs-baseline comparison strip: a baseline exists to be diffed, and only a load run has percentiles, throughput and an error rate to diff, so its chip reads "Baseline - kept past retention" and its action "Pin as baseline" / "Unpin baseline - kept past retention" (#2163: the pin's second meaning was only in a tooltip), where a design or scenario run's read "Pinned"/"Pin". The long chip is not `shrink-0`: it truncates at a narrow drawer (capped at half the identity line) and keeps its full text in a `title`, so the identity span stays the line's main text. Every pin, regardless of type, exempts the run from the engine's retention and keeps it findable under the Pinned toggle - the promise the toggle already made to every row. `DesignRunView.tsx`'s header offers the same action, for a run open on screen without going back to the list. No confirmation dialog, unlike Delete - both directions are one click from being undone. Delete's own dialog adds "This run is pinned as a baseline." for a pinned run, because naming the run deletes it where Settings' *Clear run history* would have kept it.

A **collection run's** row is a different shape, because it has no url and no method: a folder icon and the collection's name, over a chip line of step count, iterations (omitted when 1, the default) and sub-folders. The badge slot beside Delete is deliberately **empty** for one. That slot marks the types whose identity line would otherwise look alike - load and design both print a bare URL, so load carries the ⚡ - and a collection run's identity is already unmistakable, so a badge there would be the third glyph in one card saying the same thing, after the folder icon and the step count. Guarded by a test asserting no two icons in the card are the same glyph.

A **collection run** row has no url and no method - its work is a sequence - so it renders `summary.scenario` (`GET /runs`) instead: the collection's name, the plan's step count, and iterations when there was more than one pass. The name is not on the wire; `HistoryList` resolves it from the loaded tree with one shared `useCollectionsQuery` and passes it down, so the row stays presentational over already-shaped data and the page does not become one query per row. A collection deleted since its run falls back to the id it does have. The type filter carries all three run types - `filterRuns` compares its value to `run.type` directly, so a type the dropdown cannot name is one the list can only show under "All".

**Detail (`main/`):** `HistoryDetail.tsx` routes by run type to `DesignRunView.tsx` (a single request execution, opened as an editable copy), `ScenarioRunView.tsx` (a collection run's step list) or `LoadTestDetail.tsx` (load-test report), or - for a load run the engine is still executing - `components/LoadRunInProgress.tsx`.

`HistoryDetail` fetches the **run** (`useRunQuery`) and asks for the report only when the run is a load run. `GET /runs/:id/report` is a load-test aggregate: against a design run its percentiles all come from one sample and `metadata.configuration` is absent, so it cannot say what a design run's auth, scripts or redirect settings were. `GET /runs/:id` can, and for a design run it also carries the stored exchange. The header is the run tab's one `h1` for every run type (#2270) and is titled by what the run ran, not by its type and id (`run-heading.ts`'s `runTitle`): the request's name (`configSnapshot.requestName`, else the list row's `summary.requestName`; the default "New Request" says nothing and is skipped), else the collection's name for a sequence - including a collection *load* run, which is `type: "load"` - falling back to the collection's id once it is deleted, else the type's name (`RUN_TYPE_NAME`). Beside the title sit the status and the start time (`TimeValue`, so the hover card gives the zone). Under it a small line holds the type (omitted when the title already is it) and the run id in mono with an icon button, **Copy run ID**, to copy it; under that, the run's **Comment** (`runComment`: the snapshot's, else the summary's; the shared `components/shared/RunComment.tsx`, which draws nothing for an empty one). The comment used to be a "Note:" line at the foot of `LoadTestDetail`'s "Test config" box; the report no longer draws it, so a run whose only config is a comment opens no box. The header shows **no** URL - the builder below renders its own URL bar, and two stacked read as a bug. Beside the title sits a text **Copy for agent** button (#2047), once for every run type since the header is above the per-type views: it copies `loadedRunReference` (`lib/run-reference-input.ts`), which reads the run's name, method and path off `configSnapshot` because `GET /runs/:id` carries no `summary`, and names a collection run by its collection from `useCollectionsQuery`. Beside it, for a finished load run only (the `showsReport` case: the engine exports nothing else), sits the **Export** menu, `main/components/RunExportMenu.tsx` (#2139, below). A **scenario** run is not gated on its report either, for a different reason: while the sequence is still executing the live `step` stream is the content, so waiting for a report that does not yet describe a finished run would hold the tab on a skeleton for the length of the run. `ScenarioRunView` asks for the report itself.

A **load** run that is still `running` or `pending` is the opposite case, and it is not shown as a report either (#1934). The engine serves `GET /runs/:id/report` for a live run, but the numbers are the requests so far, and a tab that rendered them kept them: the report was cached as final and nothing told the tab the run had ended. So the pane fetches no report until the run has finished and renders `LoadRunInProgress` - a sentence saying the run is in progress and its results appear when it finishes, a **Stop** (`StopRunButton`, through `useStopRun`) and, only when `dashboard-store.currentRunId` is this run, an **Open dashboard** action (a run started in another window or before a relaunch is not on this window's dashboard, and the button would open an empty one). `runDetailOptions` polls the run's status every 3s while it is live, so the pane turns into the report on its own when the run ends; `LoadTestService` invalidates the run's detail, report and series on a close it watched, so that tab does not wait for the poll.

`DesignRunView.tsx` renders `RequestBuilderProvider` + `RequestBuilderLayout` with starting values from `design-run-seed.ts` (`seedFromRun`), the stored exchange as `initialResponse`, and the run's recorded collection script parts as `inheritedPreScripts` / `inheritedPostScripts`. It **holds the pane until `useRequestQuery` settles**, and tells a genuine deletion from a transport failure before seeding: `seedFromRun` reads a falsy live request as "deleted", so a query in flight, a deletion and an unreachable engine all look alike unless kept apart. The provider re-seeds only on a change of `initialRequest.id` - null for every detached copy - so an early or wrong seed would stick. Loading holds the pane behind a `DetailSkeleton`; a genuine deletion (the `RequestNotFoundError` sentinel from `useRequestQuery`, matched via `isRequestNotFound` not a message string) seeds the orphan copy that replays the recorded wire headers; any other settled error is a transport failure and renders `ErrorState` with a retry rather than guessing a copy. The run's recorded auth **mode** (`seed.recordedAuthMode`, all that survives storage) is shown read-only beside the copy, so a user can see when the request's current auth differs from what the run sent. A run whose body was a `binary` file shows the file it sent - name, size and the start of its sha256, the full hash on hover - from the trace's request node (`request.bodyFile`, read through `lib/sent-body-file.ts` and drawn by `components/shared/SentBodyFileNote.tsx`, which a scenario step's expansion in `ScenarioStepCard.tsx` renders too); the path is never recorded there, and the hash is what tells whether the file on disk has changed since. Save to request writes a binary body's file reference back, unless the snapshot recorded no path, when the saved body is kept. A run recorded before script parts existed passes its one glued string as `legacyPreScript` / `legacyPostScript`; `LegacyScriptNotice` shows it whole with a note that its parts cannot be separated, and the replay sends it as a single request-origin part. **The copy is detached** by two independent gates - `id: null` and no `onSave` - so editing it cannot rewrite the saved request. Sending again replays the recorded collection parts unchanged plus the edited request part, under the same `requestId`. `SaveRunToRequestDialog.tsx` + `save-run-to-request.ts` write chosen values back behind a confirm; they never write auth (only the mode survives storage) and never write scripts for a run stored before script parts existed. They never seed or write what the engine withheld from the snapshot (`<redacted>`, `lib/withheld-value.ts`): a credential header's recorded value is never a row (the request's own row of that name stands in, so a header the user typed still replays and saves unchanged), and a url, params or body holding the marker is left off the save as a kept row, the way a truncated body is. Those three are seeded as recorded, so the copy shows a `WithheldValuesNotice` (`history/main/components/`) warning that sending it sends the marker literally. The header also carries a Pin/Unpin button (`useSetRunBaselineMutation`, the same mutation the sidebar row uses) so a run open on screen can be kept past retention without returning to the list first. **A run an agent started that no saved request stands behind** (`run.origin.kind === "mcp"`, no `requestId`: `send_request` runs inline and the run is the only record) has nothing to overwrite, so there the header leads with Save to request as the primary action (`SaveAgentRunButton.tsx`, gated by `isUnsavedAgentRun`), and it creates a request instead. It hands `save-run-as-request.ts`'s `presetFromRun` to `useNewRequest` - the same flow as every other "New request" (the remembered collection, a new one when there are none, `CollectionPicker` when it would be a guess), which opens the new request in its own tab. The preset is `createFieldsFromRun` (`save-run-to-request.ts`), the update's field rules shared by one function so the two cannot disagree about what is safe to write (no auth, nothing withheld, no truncated body; a withheld url is saved empty), plus a name (the request name the run recorded, else `METHOD url` without the query) and the description `Saved from a run started by <product> on <date>` (`savedFromRunDescription`: the product name from `lib/mcp-client-names.ts`, an unmapped identifier as sent, `an MCP client` when none; the run's start date through `formatInstant`) so the provenance outlives the run. The run keeps its null `requestId`, so the button stays after a save and a second press saves a second copy. A linked run keeps the overwrite button, second in the header and unpromoted.

`LoadTestDetail.tsx`'s scrolling body, above the tabs, carries `main/components/BaselineComparison.tsx`, the **vs-baseline strip**: the open run's p99, throughput and error rate against the run pinned for the same request, each delta coloured by `MetricDelta.direction` rather than by its sign (latency up is a regression, throughput up is not). It resolves the pin itself through `main/components/usePinnedBaseline.ts`, the lookup the Export menu's comparison toggle shares (`useBaselineRunQuery`: by `requestId`, or by url+method for a run of an unsaved request, the url and method read off the loaded run's `configSnapshot` through `runReferenceInput`, the report's `metadata` standing in where the snapshot has neither) and fetches the run from the shared cache the pane above already filled, so it stays self-contained instead of threading a prop through every call site. It renders **nothing** when no run is pinned, when the open run *is* the pin, or before the baseline's report has loaded - a strip of zeros would claim "nothing changed" about runs that were never compared. Under the deltas it lists the **comparability warnings** (#2162), one `AlertTriangle` row per entry of `RunComparison.comparability`, each the message followed by the baseline's value and then this run's ("Run durations differ by more than 2x. 20 s vs 3 s, stopped."): run type, mode, virtual users, target rate, duration, status, HTTP version, data file, request, compression negotiation and whether `Expect: 100-continue` was allowed (#2516), because a short stopped run against a long one always reads as a throughput and tail-latency regression. A like-for-like pair draws no list. When both reports carry `metadata.runType`, a mode, virtual-user count or target rate only one recorded is a warning whose missing side reads `not recorded` ("Virtual users differ. not recorded vs 10."); otherwise a field a report does not carry is never a warning (#2438). The list is computed in `compareReports`, so `compare_runs` returns the same entries. The diff comes from `lib/run-compare.ts`, mirrored by the MCP tool's `electron/mcp/compare.ts` and pinned to it by `compare.conformance.test.ts`. Three metrics, deliberately: it is a glance above the report's tabs, and the rest of the diff (every percentile, both throughput measures, the status-code merge) is the **Compare** view below. Its label row carries a text **Copy comparison for agent** button (#2047): `runComparisonReference` over the baseline row and the open run, both mapped through `runReferenceInput`, toast "Reference copied".

**Export a finished run** (#2139). `main/components/RunExportMenu.tsx` is a `DropdownMenu` behind a text **Export** button (the `Download` glyph, styled like Copy for agent), mounted by the run tab's header and by the post-run `DashboardHeader`, each only for a finished load run. Its items are `runExportActions` from `lib/run-export-formats.ts`, the list the palette's export commands are generated from: a **Save as …** item per format ("Save as JSON", "Save as Markdown", "Save as HTML report") and a **Copy as …** item per format marked `copyable` ("Copy as Markdown"; JSON and HTML are not offered on the clipboard). The HTML report is one self-contained page with the run's charts, for a person to open or print; the engine writes it from the whole series whatever the request says, and it is the one format the MCP `export_run_report` tool does not offer (`mcp: false`). A copy goes through `useCopy` once the engine has answered, so "Markdown report copied" appears only when the clipboard took the text and a refused write toasts `Couldn't copy: <reason>` instead; a save hands the engine's `text`, `fileName` and `mimeType` to `downloadTextFile`. **Include comparison with baseline** is a checkbox item, ticked by default and present only when `usePinnedBaseline` finds a pin other than this run; ticked, the export sends that run as `baseRunId`. A foot note under a `border-rule` divider (the content declares `bg-card surface-card`, `--popover` and `--card` being one colour) says what the file carries: the target URL, names and comments, no request or response data. A save asks `useRunReportExport` (`POST /export/run-report`, the series at its default, which the HTML report needs and reads in full regardless) and only once the engine answers hands its `text`, `fileName` and `mimeType` to `downloadTextFile` untouched, toasting `Exported <file>`, plus ` - N URL credentials left out` when `notes.urlCredentialsOmitted` is above zero. A failure toasts `Couldn't export the run - <engine message>` and downloads nothing. The items are disabled while an export is in flight. The mounted menu also fills the palette's `exportRun` slot ([Command Registry](#command-registry-libcommands)).

**Compare any two runs** (#2164). The header's **Compare** action (beside the breadcrumb, drawn only for a run that has a `requestId`: a comparison needs the request to find its sibling runs by) and the History row's **Compare with…** menu entry (`RunItem`, for a finished load run with a `requestId`; it opens the run's tab and sets `tabs-store`'s `compareRunTarget`, which `LoadTestDetail` consumes) open `main/components/RunComparisonView.tsx` in place of the report's tabs. It is in-pane state of `LoadTestDetail`, not a tab type, so Back to report returns to the report. The view diffs the open run (the target) against a run chosen in a `Select` (the base): `useRequestRunsQuery` lists the request's load runs (`GET /runs?requestId=&type=load`), and `comparableRuns` keeps the completed and stopped ones other than the open run, adding the pinned baseline when it is older than the page. The default is the pinned baseline (`useBaselineRunQuery`) when it differs from the open run, else the newest other run. Option labels are the start time, the status and, for the pin, "Baseline", so two runs of one request tell apart. Under the comparability warnings it draws one table of **every** `compareReports` row (P50 to max latency, throughput and response rate, error rate, total requests) and one of the status-code merge, a code only one run saw counting zero on the other side; the change column is coloured by `MetricDelta.direction` like the strip, and a status-code count change is neutral, since counts follow how long a run ran. The strip and the view share `run-comparison-parts.tsx` (`DeltaCell`, `DeltaChange`, `ComparabilityWarnings`) and `run-comparison-format.ts` (`METRIC_LABELS`, `formatValue`), so a fix to a unit, a tone or a warning lands on both. A chosen run deleted since the list loaded shows "This run no longer exists" with the picker still open; a request with no other finished run shows an empty state.

**The request across runs** (#2165). The Performance tab ends with `main/components/RunTrend.tsx`, three small charts - p95 latency, throughput, error rate - with one point per run of the open run's request, so "is this request getting slower" reads as a line, not as ten rows to compare by eye. It is mounted by `LoadTestDetail` beside `PerformanceTab` (the tab is a view of one report; this reads the request's other runs), and it is built from the runs list's `resultSummary` (#2130) through `useRequestRunsQuery`, the query the compare picker shares: no report is fetched per run. `buildRunTrend` (`run-trend.ts`) keeps the load runs that have a summary and ended (completed, failed or stopped), takes the newest `RUN_TREND_LIMIT` (20) and orders them oldest first. **Stopped runs are included, not dropped**: a run the user ended on purpose is often the latest state of a request they stop routinely. Each is marked with a dashed rule on the charts and "stopped" in the hover heading, and the card says so, because a shorter window averages differently. The open run carries a "This run" rule, and the card says so when it is older than the plotted window. A run that did not record a figure is a gap, never a zero; a chart with fewer than two recorded runs is left out. The component renders **nothing** for a run with no `requestId` and until two runs have a summary: one point is not a trend. A failed list fetch draws an inline `ErrorState` with Try again. The x axis is the run's position, not time (runs are minutes or days apart); the hover heading is the start time through `formatInstant`. The wrappers (`RunP95TrendChart`, `RunThroughputTrendChart`, `RunErrorRateTrendChart`) live beside the other charts in `modules/dashboard/components/charts/uplot/RunTrendCharts.tsx` and use the same role per metric as the per-run charts (warning, categorical, destructive).

`ScenarioRunView.tsx` is the collection-run tab: the sequence, step by step, plus a four-number summary. It is deliberately **not** `LoadTestDetail` - a scenario run's `results[]` are step executions of *different* requests, so the load report's percentiles and status distribution would describe a sequence as though it were one request repeated.

Its list has two sources and `scenario-steps.ts` collapses both to one `ScenarioStepRow`:

| Source | Carries | When |
|---|---|---|
| `step` SSE events (`services/sse-client.ts` → `scenario-run-service.ts` → `stores/scenario-run-store.ts`) | Identity - including the `requestId` the step ran (issue #831) - outcome, status code, latency. **No exchange.** | While the run streams |
| `RunReport.results[]`, each with the step identity the engine stamps onto its trace | The stored design-mode trace, so the row expands into a response | Once the run is over |

Stored rows win the moment there are any, which is also what makes a re-opened tab honest: a completed run has no live steps and reads entirely from storage. `ScenarioRunService` refetches the report on `complete`, which is the changeover.

The header names the data file the run's rows came from (issue #2051), from the snapshot's manifest, followed by `(numbers read as numbers)` when the run cast them (issue #2540, `dataFileDisplayName` in `lib/run-data-file.ts`, which every surface naming a run's file shares), and appends `(file changed since this run)`, `(number reading changed since this run)` or `(file no longer at that path)` from the status `hooks/useDataFileStatus.ts` returns (`changed`, `readingChanged`, `unchanged`, `missing` or `unknown`). It asks the main process for the remembered file's digest (`dataFile:hash`, on mount and on window focus) and compares the run's `dataFileHash` with it (the same hash with a different `dataFileCastNumbers` against the binding's `castNumbers`, each off when absent, is `readingChanged`; a different hash is `changed` whatever the reading), or with the hash the app last recorded when there is no hash bridge. The reply is `{ status: "found", hash }` or `{ status: "missing" }` (issue #2057): "gone" rides the reply because an error crossing IPC keeps only its message. `missing` needs nothing from the run, so a run recorded before hashes still reports a moved file; a browser build, with no bridge, can never say it. Every other answer - a request the main process refused, a hash still in flight, a run recorded before hashes (for the changed and reading comparisons) - is `unknown` and shows no suffix. `lib/run-data-file.ts` holds the reads of the name/hash pair out of every stored shape and the one classification rule (`classifyDataFile`).

Three rules the list holds, each pinned by a mutation-checked test:

- **Rows key on `(iteration, stepIndex)`, never arrival order.** The SSE ring replays from `Last-Event-ID` on reconnect, so a client that resumed mid-run receives events it has already rendered; appending would double every row it re-saw. A malformed `step` payload is dropped by `parseStepEvent` rather than defaulted, because a defaulted `0:0` would *collide* with the real first step.
- **`skipped` is never `passed`.** It has its own count and its own row treatment (`SampledExchange`'s `state` prop, below). Nothing produces `skipped` until flow control lands, so it is built to render correctly before it can occur.
- **Thinned results say so.** A run that filled `maxScenarioStoredSteps` reports fewer rows than it ran, with every non-passing step among the ones kept - so a non-zero `stepsDropped` means *successes* are missing. `ScenarioRunView` discloses the three numbers rather than letting `results[]` read as the whole run.
- **The four chips count the run, not the rows** (issue #726). `outcomeCountsFromReport` reads `report.scenario.passed/failed/skipped/errored` - the engine's exact whole-run totals - and the step list's own summary is only the fallback for a live run whose report has not landed yet. Counting rows would undercount `passed` on any thinned run, since thinning drops passes alone: a 6,000-step run keeping 5,000 rows read "4,990 passed" beside a header claiming 6,000 steps, so the chip silently changed meaning with run size. The stored-row count stays the list's own disclosure line above.

- **What errors cost is said, not inferred** (issue #2526). A script error no longer ends a collection run's iteration unless the run was started with `stopOnError`, so a run can do less than its plan only because a runner refusal ended an iteration (or `stopOnError` was set). `stepsNotRunText` (`scenario-steps.ts`) words that count once for both readers: the header prints "N steps did not run" in a muted sibling span beside the iteration tally (the report's `scenario.stepsNotRun`, the run-wide sum; the tally sentence keeps its own node), and the one step whose error ended its iteration prints "Ended this iteration: N steps did not run" in its expansion, from `stepsNotRun` on the `step` frame (`parseStepEvent`) and on the stored trace (`stepRowFromResult`) - the two layers a `ScenarioStepRow` is built from, so the line does not vanish when the stored row replaces the live one. All of them are absent rather than `0` from the engine, and a report from before the field has none, so neither line renders for 0 or `undefined`.

A live run can be **stopped** from this tab (`StopRunButton`, below), which matters most for a data-driven run of hundreds of iterations. The control is shown while `isStreaming || run.status is running|pending` - two signals rather than one, because a tab reopened onto a run that is still executing (after a relaunch, or from History) has no stream at all, and is exactly the case where waiting the run out hurts most. It calls `POST /runs/:id/stop`, which needs nothing new engine-side: the scenario runner already checks `should_stop` per *step*, settles the run to `Stopped` and closes the SSE topic, so the streaming tab flips to the stored rows through the same `complete` a normal finish takes. `useStopRun` also invalidates the run and its report itself, because a tab that is not the streaming one never receives that event.

`components/ScenarioStepCard.tsx` renders one step on the shared `SampledExchange`, restoring the response through `restore-response.ts` - the same path a design run's response pane uses, not a second reading of `trace_data`. It is `memo`ized (issue #1153): up to 200 are mounted while a run streams several commits a second, and all but the newest are rendering what they rendered before. That only bites because the list hands down props that hold their identity - one `onToggle` for every row rather than an arrow per row, which is why the card is told *which* step it is instead of the handler closing over it. `SampledExchange` gained an optional `state` (`success | error | slow | skipped`) and a `title` slot for this: its state is otherwise derived from the status code, which would read a `failed` assertion over a `200` as a success and a `skipped` step as a connection failure.

**A step is no longer a dead end** (issue #730). The engine has always stamped `requestId` onto a step's trace and no renderer read it, so reproducing "iteration 501 - row 501 failed" meant hunting the request in the tree by name, and then finding that the send-with-row picker lists the first 20 rows, which do not include row 501. The card now carries an action beside its summary: **Repro row N** opens that request through `tabs-store`'s `openRequestWithDataRow`, which selects the row that iteration bound and opens the picker on it - so the repro is that click and the row's. A step of a run that bound no data set says **Open request** and carries no row, because a collection with no data file has none to select. A **live** row carries the action too (issue #831): the `step` frame names the request, so a step that has just failed on iteration 12 of 500 is one click from the request that sent it rather than a link that arrives when the run ends - which is the moment it is worth least. The expansion is still what waits for the stored row; the id is one constant-size field, which is what lets the frame carry it where the assertion list stays stored. A row that cannot name a request offers nothing at all rather than a disabled control: a step whose plan entry has no stored request behind it, and a row stored before the runner stamped one. `SampledExchange` gained an `actions` slot for this, rendered *outside* the summary button - the summary is one `<button>`, and a control nested in it would be invalid markup that fires the toggle on its way out.

**The list is bounded in cost, not in content** (issue #730). `maxScenarioStoredSteps` is 5,000 and every row used to mount as a card. The four count chips are now buttons that filter the list to one outcome - the reader who has just read "11 failed" wants those eleven, and the number is where they read it - and the rows arrive through `useGrowingWindow`, the same growing list the response pane's console output uses (held here by `useFilteredSteps`, see below), each card marked `skip-offscreen` so the ones scrolled past cost no layout. No virtualiser, for the reason that hook records: step cards vary in height, and variable-height windowing means a scroll map to maintain forever. Filtering to an outcome whose *stored* rows are all gone (thinning drops passes) says so in its empty state rather than reading as a contradiction with the chip, which counts the run.

**A search beside the chips, matching the step name** (issue #832). The outcome filter cannot answer "show me every execution of `POST /checkout`": a 5,000-step run of a 40-request collection is 40 names repeated 125 times, and the failures a chip narrows to are spread across a dozen different steps. The box matches the **step name**, stated on the field itself (`Search step names`) rather than left to be guessed - it is the one field both sources carry, where a row's URL lives in its stored trace and a live row has none, so matching that would make the same box search less while a run streams than after it ends. The two controls are **one predicate** (`filterSteps` in `scenario-steps.ts`), so narrowing by both is the useful case rather than a special one, and there is a single empty state (`emptyStepListReason`) that names whichever combination emptied the list - the chip and the search are cleared in different places, and a reader told "no failed steps" over a list their search emptied clears the wrong control. The outcome half of that message keeps the thinning disclosure it always carried. The growing window is keyed on *which* list is shown - the run, the pressed chip and the search text - so a narrowed list starts at its own top while a live run's list, which is the same list getting longer, keeps the window a reader has scrolled open (issue #1153). `useFilteredSteps` owns that window rather than the view holding it beside the hook (issue #1297): the window is sized against the match count and the count is what says how far the window has to be produced, so keeping them apart would be two caches over the same rows with the same three ways to go stale - the filter, the list's identity, a replay - and nothing to fail loudly if they drifted. **A live run runs that predicate over the batch that just arrived, not over the run, and builds only the rows it shows** (issues #1205, #1297): `useFilteredSteps` counts what the batch added and extends the window from the source row it was last produced through, so pressing a chip or typing in the box no longer costs a pass over every row the run has produced on every flush - the whole cost of a narrowed list used to fall on the reader who narrowed it. Once the window is full the extension stops for good and the rows are handed back by identity, so a long run streaming past a filled window copies nothing per flush; a grown window resumes from where it stopped rather than matching the list again. What tells it the list only grew is the store's `appendEpoch`, since every commit hands the view a new array; anything else - a replay that replaced a row, a new run, the changeover to the report's stored rows - rebuilds. The rows, their order, the "showing X of Y" total and every empty state are what `filterSteps` produces for the same inputs, proven against it as an oracle over randomized streams at more than one window size, and `stepMatcher` is the one definition of the predicate that both the oracle and the window read.

For a step of a **spec-bound** collection the row also carries the shared `ValidationChip` beside its outcome chip, and the expansion renders the same `SchemaValidation` section the response pane's Tests tab does (issue #681) - both shared rather than re-laid-out here, so the three-state wording and the unevaluated-keyword disclosure cannot drift between the two surfaces. It sits *beside* the outcome and never inside it: with `failOnSchemaError` off, a step can pass every assertion while its response contradicts the contract, and those are two facts. A step of an unbound collection, or one that sent nothing, renders neither - `step.validation` is absent, and absent is never drawn as "checked, and fine".

The row carries its **assertions** the same way (issue #724): the shared `TestsChip` beside the verdict, and the expansion renders the response pane's own `TestResults` list from the stored trace's `scripts` node - the run computed every `pm.test` result and kept only a one-line summary of it, so a step's detail showed nothing where the same request's single Send showed a full Tests tab. The tally is the only half a *live* step has, because a collection run is answered `202` and its steps are viewed entirely through their stored rows; the list arrives when the run ends. The stored list wins the moment there is one, tallied by `tallyTests` in `scenario-steps.ts`, so a row does not change its numbers when its stored copy lands. Both count both scripts' assertions (issue #810) - a failing `pm.test` fails its step whichever script made it - and the list is grouped under the script's name, so an assertion made before the request went out does not read as one about the response.

The entry point is `modules/collections/RunCollectionDialog.tsx`, opened from a collection row's ⋯ menu. Seven options - Recursive, Iterations (replaced by the load profile once Load test is on), a data file, Load test, Fail steps on schema errors (issue #720, the renderer's only writer of the engine's `failOnSchemaError` - MCP's `run_collection` is the other, issue #766 - hidden in load mode because only the design-mode runner can honour it), Stop the iteration on a script error (issue #2526, the same shape for the engine's `stopOnError`: off by default, so a script error is reported on its step and the iteration moves on as in Postman; top-level, sent only when on, hidden in load mode; MCP's `run_collection` is the other writer), and Pass/fail budgets - because the scenario **is** the folder: the sequence is the tree's own ordering, and a step list authored here would be a second source of truth for it. Invalid iterations are refused in the dialog; the engine's own rejection (which names the step that would not compose) is shown in place rather than as a toast that scrolls away.

**Pass/fail budgets** (issue #1564) reuses `LoadTestConfigDialog`'s own `budgets.ts` and [`NumberField`](#number-field-componentssharednumberfieldtsx) rather than a second copy - the engine now judges a collection run against `thresholds` exactly as it always has a load run. Unlike Timers/Scripts below, it is **not** gated by Load test: it applies to a design-mode run and a load run of the same folder alike, so the disclosure always renders. An out-of-range budget blocks Run with the same named message `LoadTestConfigDialog` shows. Its disclosure is `LoadTestConfigDialog`'s own `DisclosureCard` (it hand-rolled the same `Collapsible` chrome until #2194), so the closed card shows the same budget count and the explainer is the shared `BUDGETS_EXPLAINER`; nothing is seeded or remembered here, so it has no carried-over notice and its p99 field carries no SLO hint.

The **Custom metric budgets** rows inside it (issue #1579, the same `CustomBudgetRows.tsx` the load dialog mounts) follow the same rule as the fixed budgets above, not gated by Load test: `custom.<name>.<stat>` is judged for a design-mode collection run exactly as it is for a load run (`docs/engine/api-reference.md`, the thresholds block), so the rows always render and reach the payload regardless of the switch. They get no "Copy for agent" button here: `CustomBudgetRows`' `referenceOwner` names a saved request, and a collection run has none.

**Load test** (issue #357) is the same plan on a different executor: the payload gains a load `mode`, and its presence is exactly what the engine reads to choose one, so a design-mode payload keeps its meaning by carrying no mode at all. It lives here rather than in the request builder's `LoadTestConfigDialog` because that dialog's target is the request that is open, and a scenario's target is a folder - picked here, by the tree that already owns the choice. Turning it on swaps the design-mode Iterations field for a **load profile**: the request dialog's own `ProfilePicker` and `ProfileFields` narrowed to the three modes a scenario accepts (`SCENARIO_LOAD_MODES` in `LoadTestConfigDialog/scenarioProfile.ts`) - Constant virtual users, **Fixed passes** and Ramp-up. Constant RPS and Capacity discovery are not offered because the engine answers a scenario with either a `400`. The picker takes optional `modes` and a per-mode `copy` override, and `ProfileFields` an `iterationsLabel`, so Fixed request count reads "Fixed passes" / "Passes through the sequence" here without touching `LOAD_TEST_MODES` (`loadTestModeLabel` names stored runs everywhere else); `summarise` takes a `"sequence"` subject so the line under the fields counts passes ("Runs the sequence N times across M virtual users, then stops.") and never calls one a request. The profile starts from the dialog's own numbers (10 virtual users, 30 s, 100 passes, a 10 s ramp) and neither reads nor writes the request dialog's saved config: that memo describes one request, and a sequence multiplies its load. The per-mode field selection is `profileParams` (`profile.ts`), shared with `buildLoadTestConfig`; `scenarioLoadFields` spells the same selection the way `StartScenarioRunRequest` reads it (camelCase, `"Ns"` durations, `iterations` omitting `duration`), and that one object is both the payload's load half and the seed for `useDashboardStore.startRun`, so the dashboard shows the mode and ramp the run was started with. Run stays disabled with a named message for a value outside the Settings ceilings (`resolveLoadTestLimits`) or a ramp that does not fit its duration (`scenarioProfileError`, reusing `validateRampDuration` / `validateStartConcurrency`), so an over-ceiling count is refused before the request. The line under the title follows the switch and the mode ("repeating for the duration", or "taking passes until the total is reached" for Fixed passes). It also swaps what happens after the `202`: a load run publishes `metrics` ticks and no `step` events, so it attaches `loadTestService` and opens the **dashboard**, where a design-mode run attaches `scenarioRunService` and opens the runner tab. Attaching the wrong one is not a degraded view, it is a permanently empty one.

The dialog also gains **Timers** (`asConfigured` | `off`) and, in Load mode only, **Scripts** (`asMarked` | `allInline` | `allDeferred`), issue #1552 - the app-side twin of the `elements` pipeline override issue #1495 defined engine-side, documented in full at [api-reference.md](../engine/api-reference.md#the-elements-block-element-pipeline-override). Both are sent as a top-level `elements` object beside `mode`/`scenario`, never inside the `scenario` block itself, and only when changed from the engine's own default - the same "absent means the default" rule `failOnSchemaError` follows. `Timers` is wired to `timer.pacing`/`timer.think` end to end and applies to a design-mode run exactly as it does a load run, so it is offered regardless of Load test; `Scripts` decides whether a `script.*` element runs inline on the event-loop worker or stays deferred to the post-run replay, and has no effect on a design-mode run (which already runs every script inline), which is why that one control only appears once Load test is on. `LoadTestConfigDialog`'s single-request path gained the same `elements` attachment point in issue #1594 - its own step-level elements ride under `requestElements` instead, a distinct key from this run-level override - and mirrors this dialog's own **Scripts** control (`asMarked` | `allInline` | `allDeferred`), sent the same way, only when changed from the default. It is what makes the dialog's own pre-request-script warning conditional: `allInline` is the one setting that gets an unmarked `script.pre` to actually run under load, so the warning hides once it is chosen. The post-request sampling notice hides at the same setting, for the mirror reason: `allInline` runs a `script.post` on every response instead of replaying it on a sample. It offers no **Timers** twin, but not because the engine ignores the override there - `elements.timers` applies to a single target's own `timer.think` exactly the way it does to a scenario step's - the dialog simply has no timer control of its own on this path to pair it with yet.

`modules/collections/DataFilePicker.tsx` is the data-file half (issue #402). It reads a CSV/TSV/JSON/JSONL file through a hidden `<input type="file">` + `FileReader` - the `ImportModal` precedent, deliberately no Electron dialog IPC - decodes its **bytes** (`decodeDataFile`, so a non-UTF-8 export is named rather than parsed into question marks), parses it with `services/data-files/`, and previews the first ten rows in the `ui/table.tsx` grid. The preview scrolls inside its own box and says which rows are in it in either direction - "the first 10 of 24" for a long file, "all 8 rows" for a short one - because the box can cut a file off without looking cut off, and on overlay-scrollbar platforms it draws no scrollbar until someone scrolls it. What keeps that box from widening its host instead of scrolling is the host's, not the picker's: a width-capped grid surface has to clamp its own track (issue #701, `DialogContent`'s `grid-cols-1`; see [design-system.md](../design-system.md)), and the Data tab's flex column already hands its children a definite width. Two things it exists to say **before** the run rather than after: everything the engine would reject (a ragged row, a duplicated column, a non-object, a line that will not parse, a set over `maxScenarioDataRows` or `maxScenarioDataBytes`) is refused here with the row, line or setting named - the two caps read live through `useDataFileLimits` rather than restated, so raising one engine-side is enough, and the **resolved iteration count** is stated, because an explicit `iterations` wins over the row count - a 500-row file with Iterations left at 1 runs once. Picking a file blanks a **pristine** `1` so the field shows what will happen - pristine and not merely equal to `1`, because a deliberately typed `1` reads the same and clearing it would turn one pass into a full pass per row, and `iterations` is then omitted from the payload entirely: the engine owns "absent means one pass per row", and a client computing the row count itself would be a second copy of that rule. The previewed rows and the sent rows are one array; the parent holds the single `ParsedDataFile`. The picker also hashes the same raw bytes (`sha256Hex`, the digest the main process takes for a re-read), and both dialogs send the file's name and that hash beside the rows as `dataFileName` / `dataFileHash` (issue #2051) - never its path. In both run dialogs a pick also declares the contract from the file's columns and Remove clears it (issue #2050), through `hooks/useDataContractWriter.ts`, the writer the Data tab uses; the rows themselves are held for the run request and no longer - neither side stores the set, and the declare-mode label says the contract records their shape rather than their values, since the values a run binds do persist in its step traces ([What is stored](data-driven-runs.md#what-is-stored), issue #731). For a CSV or TSV the preview card carries a **Read numbers as numbers** checkbox (issue #2540). A toggle re-parses the selection's own decoded `text`, which `SelectedDataFile` holds beside the rows in memory only, so a file with no path re-parses too and the preview never reads bytes other than the ones it showed. It reaches the host through `onCastNumbersChange`, never `onSelect`, because every host treats a pick as a new file and declares it; the host keeps the setting on the collection's binding through `useDataContractWriter`'s `rememberReading`, and a pick starts it off. The selection's `parsed.castNumbers` is the setting in force. The user-facing file contract lives in [Data-Driven Runs](data-driven-runs.md).

`CollectionDetail/DataTab.tsx` is the authoring-time half of the same file (issue #599, phase 1 of #598). It reuses the picker in `mode="declare"` - same parser, same refusals, no iteration arithmetic - and turns a picked file's columns into `collection.dataSchema` through `useUpdateCollectionMutation` - the pick is the save (issue #2043), and the picker's `onRemove` (Remove only, never a refused file's `onSelect(null)`) clears the contract; the mount re-read of the remembered file is preview-only and never writes. **Clear** sends `dataSchema: null`, not `{}`: the engine reads absent as "keep", so a cleared contract is only expressible as a null that survives to the wire. What is stored splits by what it is true of: the **columns** are the same on every machine and ride the engine row; the file's **path** is true of one filesystem and lives in `stores/data-file-store.ts`; the **rows** are true of nobody and are stored nowhere at all. When both a contract and a file are in hand, `services/data-files/schema-diff.ts` renders the mismatch in both directions into the picker's warnings slot - shared with the run dialog, so the tab and the runner cannot describe the same file differently.

`CollectionDetail/SpecTab.tsx` is the same two-halves split one contract over (issue #638, phase 1b of #625). The **document** and the binding (`collection.openapi` -> the engine's `spec_documents`) are the same on every machine and ride the engine; a picked file's **path** is true of one filesystem and lives in `stores/spec-file-store.ts`, which holds a path and a file name and no spec content at all. Binding a collection that was not imported from a spec goes through `POST /specs/describe` - which is what the engine reads out of the picked bytes: the dialect, the title and the identities it declares, so the tab parses no document at all (issue #869 retired `services/openapi/spec-operations.ts` with the last parse) - and `POST /specs/match`, which pairs them - the matcher moved into the engine in issue #761 so an agent over MCP can bind a collection the same way, and it reduces both sides to a path shape (origin, query and fragment dropped; `{{petId}}` and `{petId}` flattened alike) and refuses an ambiguous pair rather than guessing. `services/openapi/operation-match.ts` kept only that reduction, and it is gone with the sync diff (issue #854) - the export took the URL split with it when it moved engine-side (issue #855), and nothing here reduces a path shape any more. The bind itself is one call (`useBindSpecMutation` in `queries/specs.ts` -> `POST /specs/bind`, issue #862): the document, the binding and both halves of the stamping - what matched, and what the new document no longer accounts for - commit together, and the pairing is worked out engine-side from the bytes it stores. It was three ordered writes from the renderer until then, which is three places for a bind to stop and, in the clearing half, a list a caller could forget (issue #718). The user-facing contract lives in [OpenAPI Collections](openapi.md).

`CollectionDetail/SpecSync.tsx` is the read half of keeping that binding in step (issue #654, phase 2b of #625), and its whole design follows from writing nothing: `services/openapi/spec-refetch.ts` re-reads the document from the URL the binding stored or, failing that, through the `specFile:read` gate the picked file's siblings already use (it reads only a document the user picked, dropped or opened, #2357, so a binding made before that rule shows "pick the file again" until it is picked once more) - the document naming *itself* as the file beside itself, rather than a second gated channel repeating the extension allowlist and the byte cap - and runs it through `bundleExternalRefs`, because the stored document is the bundled one and an unbundled comparison would report every external `$ref` as a change forever. "Up to date" is **byte equality against the stored document**, not a renderer-side SHA-256: the engine hashes what it stores (`spec_content_hash`), and a second hasher here could only drift. `POST /specs/diff` then produces the three buckets (issue #854 moved the comparison engine-side, where the reader that says what a document produces already lives) - it follows an operation by `operationId` first and path shape second, so a path moved under a stable id and an id moved under a stable path both stay one operation while both-moved is disclosed as a removal plus an addition, and it flags a field as **user-touched** three-way (what the request holds is neither the new document's value nor the bound one's), which is the flag the apply half may not overwrite silently. The section sends the collection and the re-fetched bytes and nothing else: the engine walks the subtree itself and reads the bound document from the binding, which is also why "up to date" is now that route's `identical` rather than a comparison made here.

The apply half (issue #655, phase 2c) keeps the same split: `services/openapi/spec-apply.ts` is a pure module that turns a diff plus a set of ticks into the `POST /specs/sync` body. The two rules a user's work depends on - a field marked user-touched is never written unless it was ticked, and a deletion is never a default - moved engine-side in issue #871 (`core::safe_spec_apply`), reported per entry on the diff as `safe` / `safeFields` and applied for a caller that states no rows by `POST /specs/sync`'s `policy: "safe"`; `defaultSelection` reads those marks rather than deriving them, so an agent's `sync_spec` and an untouched Apply here write the same rows. It reuses `services/importers/request-payload.ts` for the draft-to-payload mapping, shared with the import orchestrator so a field added for one write path cannot go missing on the other, and files an added operation in the tag folder an import would have used (matched by name, created once per tag). The write itself is one call and one engine transaction (`useSyncSpecMutation`): the document, the moved binding and every created, updated and deleted request land together or not at all, and the engine - not the payload - is what keeps a user-saved example out of a refresh and a request outside the bound subtree out of reach.

`modules/collections/ExportSpecDialog.tsx` is the way back out (issue #630, phase 5 of #625), opened from a collection row's ⋯ menu and from the Spec tab - one dialog, so the two entry points cannot describe the same export differently. **The assembly is the engine's** (`POST /specs/export`, issue #855): it reads the subtree, each request's examples and the bound document itself, and answers with the finished text, a file name and the notes. It used to be three renderer queries and ~900 lines in `services/exporters/`, which is also why the dialog once had to schedule its work off the render pass - a 12 MB spec spent seconds parsing and patching on the main thread. What is left here is the format choice, the bound collection's mode choice (**Changes: Values only**, the default, or **All edits**, which writes every edit into the document - a free-form collection has no contract to keep and is not asked, read off `collection.openapi.specId`, the same fact the engine picks the direction from), the summary and the download; `useSpecExportQuery` keys the read by format and mode so toggling back is free, and by the moment the dialog mounted so reopening it asks again. Because format is part of the key, switching it is a cache miss - so the read carries `placeholderData` (issue #1311) and the summary card stays on screen while the other serialization assembles, with a spinner beside the toggle and Copy and Download disabled for that one round trip, rather than the card being torn down for a one-line spinner and the dialog, which centres on itself, moving both of its edges twice. The first read has no previous answer to keep and holds the card's footprint instead, so the dialog opens at about the height it will keep.

Which of the two directions runs is not a setting but a fact about the collection, and the dialog says which before anything is written. A **bound** collection exports its own stored document, patched: operations nothing here claims are removed, request values become declared parameters' examples, stored examples become response examples where they are news to the document (one it already declares, or one the import sampled off a schema, is counted rather than written, #1442), and every member Vayu does not model - a `$ref` response among them - is carried through by simply not being visited. A **free-form** collection gets a skeleton - "a starting point" in the dialog's own words - which invents nothing: no schema that was not read off an example body, no `required` from a row's enabled toggle, no response for a status nobody saved. The summary lists only the counts a user can act on or would miss, and only when they are not zero (the requests-exported headline always), among them the credentials withheld in either mode - a `Values only` export counts them at the parameter they would have filled - and a closing line that bodies, examples and scripts are not checked for credentials and are written as they are; the engine's notes carry every count, and the rules behind them are `engine/include/vayu/core/openapi_export.hpp`. Delivery is `downloadTextFile` (`lib/download-text-file.ts`, the app's one file-to-disk path, shared with `ResponseActions` and the environment export); there is no save-dialog IPC and none is needed. The user-facing contract lives in [OpenAPI Collections](openapi.md).

`modules/collections/ExportPostmanDialog.tsx` is the other way out: the collection as a Postman Collection v2.1 document, opened from a collection row's ⋯ menu (**Export as Postman Collection**, beside the OpenAPI entry rather than in a submenu, because `RowAction` is one flat list both row menus draw) and from the Spec tab's Export menu. Built on `ExportSpecDialog`'s terms: the engine assembles it (`POST /export/postman`), the dialog is mounted only while open, delivery is the same `downloadTextFile` under the engine's `fileName`, and `usePostmanExportQuery` (`queries/exports.ts`) keeps the previous answer on screen while the one toggle re-reads (issue #1311). That toggle is **Include credentials**, off by default: off writes auth secrets, secret variables and, by name, the credentials in headers, parameters, URLs, saved examples and cookies empty, and the summary counts them and says that bodies and scripts are not checked and are written as they are; on writes everything as stored, which is what Postman's own export does. The summary states requests and nested collections exported and lists every `notes.notCarried` entry with its count, in the engine's words, so nothing Postman has no place for is dropped without a line saying so.

`modules/collections/SpecReimportDialog.tsx` is the fork an import takes when the document is one a collection already binds (issue #680). `ImportModal` asks `services/openapi/bound-spec-match.ts` at Import time - matching `spec_documents.source_url` and the stored bytes, the two keys that catch a moved document and a re-picked file respectively - and this dialog names the collection, offers **Sync instead** (which opens that collection's Spec tab through `tabs-store`'s `specTabTarget`) and **Import anyway**, which does exactly what Import did before the check existed. A second copy of a spec is a real thing to want, so it is a fork and never a block; the Sync action sits on the row rather than in the footer, because a batch can carry more than one bound document and one footer button would have to guess which collection it meant.

`CollectionDetail/ColumnAudit.tsx` is phase 2's half of the tab (issue #600):
the contract against the **requests** rather than against a file, so it needs no
file at all. It buckets the declared columns into referenced, referenced-but-
undeclared (amber, and the typo case this exists to catch) and
declared-but-unreferenced, scanning the fields the engine's binder walks - URL,
params, header names and values, body text, form field names and values
(`services/data-files/column-audit.ts`). **Which requests**: everything the
contract binds - this collection and every descendant down to one that declares
its own (`collectionsUnderContract`) - because auditing the leaf alone would
call a column unreferenced while a request one level down references it.
Scripts are scanned for literal `pm.iterationData.get("column")` arguments only
and the line says so: a computed argument is unanswerable at authoring time, and
the engine remains the run-time authority. The panel picks which collections to
audit; gathering their requests, resolving inherited auth and collecting the
chain's scripts is `hooks/useColumnAudit.ts`, which also takes an explicit list
of requests for a caller auditing one request rather than a collection.

`RunCollectionDialog` **pre-fills from that declaration** as part of mount, which is what keeps the dialog's mount-is-reset contract intact: if `data-file-store` holds a path for this collection it re-reads it over the `dataFile:read` IPC (`electron/data-file.ts` - extension allowlist, the grant registry (only a file the user picked, dropped or opened is read, #2357) and the engine's fetched `maxScenarioDataBytes`), decodes and parses it with the same modules the picker uses, and diffs it against the declared columns. A file that has moved, or that was declared before grants existed, leaves the picker empty and a sentence saying so - a warning, never a blocker, because a run without a file is a legal run and re-picking is the whole remedy. The pre-fill is a read and declares nothing (its one store write is the re-read file's hash, issue #2051); a **pick** declares the contract from the picked file for the collection the run binds against, and Remove clears it (issue #2050, `hooks/useDataContractWriter.ts`, the Data tab's own writer). A declare that fails is a warning beside the picker and leaves the file selected and Run enabled. Beside the contract diff, the picker's warnings name any column the run's requests reference that the file does not carry (`hooks/useColumnAudit.ts` over the collection, and its whole subtree under Recursive).

The picker is told **which run it is for** (`loadTest`), because a row means something different in each and describing one of the two is being wrong about the other (issue #449). In design mode a row is an iteration and the file's length is the run's length. In load mode the rows are claimed from a cursor every virtual user shares, wrapping for as long as the duration lasts - so the row count says nothing about how long the run is, only that no two virtual users start on the same row while unclaimed rows remain (past the wrap they do share rows), and the resolved-iteration sentence is replaced rather than shown against a pass count a load run does not have.

`services/data-files/` is the parser: `tabular.ts` (a hand-rolled RFC 4180 tokenizer - quoted delimiters, embedded newlines, doubled quotes, CRLF - shared by CSV and TSV, which differ only in the delimiter; `parseDelimited` returns the text grid and `tokenizeDelimited` also returns which cells were quoted), `numeric-cell.ts` (the number cast) and `index.ts` (format detection by extension with a content sniff fallback, the header rules, the JSON/JSONL paths). CSV and TSV values are **strings by default**, so `007` survives; `parseDataFile(text, name, { castNumbers: true })` is the per-file opt-in that reads an unquoted integer or decimal cell as a number (a quoted cell, `1e3`, `.5`, an unsafe integer and a lossy decimal stay text; the integer and decimal subset of Newman's `--csv-auto-parse`, #2540) and the result echoes `castNumbers`. JSON and JSONL keep native types and ignore the option, and the preview states which reading is in force. The header row *is* the mapping - column names become `{{data.column}}` tokens and `pm.iterationData` keys - so an empty or duplicated header cell is a parse error rather than a column nobody can address.

`LoadTestDetail` is **mode-aware** (the run context, the Overview and the tabs adapt to the run's mode, derived via `reportToDerived` → the same `DashboardDerived` shape the live dashboard uses) and composes the tabbed report under `main/components/`. It is also what the dashboard renders for a finished run (issue #2220), keyed on the run id, so a run reads the same right after it ends as from History later. Its fixed header is one breadcrumb row (with the **Compare** action) and the tab strip, and nothing else (#2271): the pane gives the run's own content the height. Everything the report says about the run before its tabs is one `runContext` block at the top of the scrolling body, drawn in the same order on every tab and, when comparing, above the comparison (`RunComparisonView`'s `runContext` slot, so it scrolls with it): the outcome banner, the request bar (`SEQUENCE` for a scenario load run, else method and URL), `RunConfigSummary`, the vs-baseline strip and the auth-refresh note:

| Component | Role |
|---|---|
| `RunConfigSummary.tsx` | The "Test config" box: one line of mode, virtual users, duration and protocol (with the "not negotiated" correction beside the protocol when the engine counted a downgrade), and a text **Details** disclosure (the bare `Collapsible`, closed by default and absent when there is nothing to put in it) holding target RPS, the bound data set and the timeout |
| `RunKeyMetrics.tsx` | The p99, total requests and success rate tiles at the top of the Overview tab, before the hero cards; the one place in the tree besides `RunItem` allowed `text-purple-500` (the P99 arrow; see `palette-tokens.test.ts`) |
| `OverviewTab.tsx` | Summary - opens on `RunKeyMetrics`, then renders the dashboard's mode-adaptive `HeroRow` + `ModeStatsRow`; the Rate-Control card is gated to `constant_rps`; also the shared `ThresholdVerdict`, `CustomMetricsSummary`, `ContractCoverage`, `SampledSchemaValidation`, `ScriptLifecycleSummary`, `RequestElementsSummary` (a single-request run's own `extract.*`/`assert.*`/`timer.*` outcomes, issues #1594/#1641 - absent for a scenario run, whose per-step tallies live in the Steps tab instead), `ErrorSummary` (the error card; given `onOpenSample` by `LoadTestDetail`, its status and error-type rows open the Samples tab at the first loaded sample they count, via `locateSample` in `sample-filter.ts`, and a row with no loaded sample is disabled), and `TestValidationSummary` (the last carrying the run's named `pm.test` failures and passed `totalRequests`, so its tested-of-total line has a denominator); `SlowRequestsCard.tsx` ends the tab with the count (`formatNumber`), threshold (`formatLatency`) and share (`formatPercent`, one decimal) behind the Samples tab's Slow chip, absent when `slowRequests.count` is 0 or the run set no slow threshold; the count is exact (#2399), so its footer says how many of them the run kept as samples (`slowRequests.tracesStored`, capped) and that the rest have no row on the Samples tab |
| `RunEvents.tsx` | The run's detected anomaly windows in words (`detectAnomalies`), plus any stretch the host spent asleep under the run (`stores/host-sleep-store.ts`, issue #1357); each window's start and end read through `formatSeconds` (`41.20s`, `75s`); silent for a clean run that the machine stayed awake for |
| `PerformanceTab.tsx` | Latency/throughput detail; the run-level phase averages card (`PhaseAveragesCard.tsx`, "Timing breakdown", `longLabel` per phase, gated by `hasPhaseAverages` so a percentiles-only report prints no card of dashes) sits beside the per-phase percentiles. A finished run also gets what the dashboard's report showed: the HDR percentile plot (`HdrPercentileChart`, the "HDR percentile plot" card, always present) with its min / mean / p50 / p95 / p99 / max footer, and a "Stream events" card (`StreamMetrics`, gated on `report.stream`, so only a streaming run has it). Its percentile and ramp_up scatter cards, and `HistoricalChartsSection`'s request-rate card, carry the `ChartLegend` the live view gives them (#2697). The dashboard's "Avg request timing" waterfall is not a card here: it draws the same `hasPhaseAverages` data the Timing breakdown card prints |
| `RunTrend.tsx`, `run-trend.ts` | p95, throughput and error rate across the open run's request's runs, from the runs list's `resultSummary`; mounted under the Performance tab, absent for a run with no `requestId` or fewer than two summarised runs (#2165) |
| `SamplesTab.tsx`, `SampleRequestCard.tsx` | Sampled request/response pairs; the synthetic test-validation row (`test-validation.ts`) is dropped here so it is never drawn as a request with no response. When the report says the engine cut `results` (`resultsStored > resultsCap`, #2210) a second badge beside "N samples shown" reads "N of M stored"; it is absent when every stored row is shown or on a report from an engine that predates the pair. The tab opens oldest first (`sample-filter.ts`: stable sort by `timestamp`) and a row's `#N` is its place in that order, so a chip never renumbers it and the open row is keyed by it. A `ToggleGroup` of status-class chips with counts over the loaded rows (All, Errors, 4xx, 5xx, No response, Slow) narrows the list; Errors is `isErrorStatus`, the classes are `httpStatusClass`, and Slow is the engine's `trace.isSlow` verdict. "N samples shown" counts the visible rows; "N of M stored" counts the loaded ones; both numbers go through `formatNumber`. The selected chip is local unless the owner passes `filter` / `onFilterChange`; `LoadTestDetail` does, because Radix unmounts an inactive tab and a local chip would reset on every switch. `initialExpandedNumber` opens one row at mount: an Overview error row (#2213) sets the chip and that number and switches to this tab, and any tab the user then picks clears the number, so returning to Samples does not re-open it. Each header carries a "Copy for agent" icon button (`runSampleReference`, #2047) in `SampledExchange`'s `actions` slot, outside the toggle. An open row also states what its trace carries (`SampleTraceDetails.tsx`, in the `details` slot): "Error type", "Data row: N" (`trace.dataRowIndex`, row 0 included, #449) and the "Failed tests (N)" list of `trace.failures` (#111); a slow sample gets the "Slow request" `Callout` with its `totalMs` against `thresholdMs`, both through `formatLatency` (the elapsed time is left out when the trace has none, rather than printing a bare unit); each header's latency reads through `formatLatency` too. The captured bodies come from `GET /runs/:id/samples`, requested only once a row is open and joined to the row by `sample.id` |
| `ScenarioStepsTab.tsx` | Per-step latency and counts for a **scenario load run** - see below; its element rows are the shared `ElementTally` |
| `TimingBreakdown.tsx` | DNS/connect/TLS/first-byte/download breakdown |
| `LatencyMetric.tsx`, `HistoricalChartsSection.tsx` | Metric cards + historical charts. `LatencyMetric` draws its value and unit from `formatLatencyParts` (1234 ms reads `1.23 s`), is neutral and takes the warning tier (P95) or the danger tier (P99, P999) only once its value exceeds the `sloThresholdMs` client setting (#2245). A failed time-series fetch (`LoadTestDetail`'s `seriesFailure`) draws the shared `ErrorState` with Try again, which reads the series again, instead of the "Not enough data for charts yet" `EmptyState` (issue #1944); the series is one `maxPoints` request, never paged (#2547). A series the engine downsampled carries `ticksPerBucket`, and the section opens with an info `Callout` saying what one point covers and how the events judged over it differ. The first load is a labelled `DetailSkeleton`, not a spinner card (#2314). The server vitals are one `maxPoints` request as well (#2611), never paged; when the engine folded them (`monitorTicksPerBucket`) the Server vitals card opens with its own info `Callout` - "Each point covers N scrapes", each series its highest value among them - independent of the tick series' note. A failed server-vitals fetch (`monitorFailure`) is a warning `Callout` with Try again which refetches the one request, drawn above the section whatever the time series holds; nothing requests it again on its own (issue #2062) |
| `MonitorSummary.tsx` | Per-series min/avg/max for the run's server-vitals scrape (scrape counts through `formatNumber`), under the Performance tab's chart. Present whenever `report.monitor` is - including the run whose every scrape failed, which has a failure count and no line to draw, and read as an unexplained empty chart before it |

A **scenario load run** lands in `LoadTestDetail`, not `ScenarioRunView`: it is `type: "load"`, publishes ticks and reports percentiles like any load run, and its target simply happens to be a sequence. Two things follow, both keyed off `report.scenario.steps` being present rather than off a run-type flag - that array is what this pane actually needs to render. It has no single method and URL, so the request bar says what the sequence was instead of the "GET Unknown URL" fallback, which the reader cannot tell apart from a broken run. And it stores no per-step `results` rows - one row per step per iteration per virtual user is what a load run exists not to keep - so `ScenarioStepsTab.tsx` renders the engine's per-step histogram breakdown, the only per-step record such a run has. Its `(n short)` marker is the visible shape of a step that got no response ending its iterations early, which otherwise reads as a run that simply lost requests. The **Errors** column is wider than that: it counts every response outside 2xx/3xx as well as the no-response executions (the run's one error definition, issue #2124), and only the latter end an iteration. The red count carries a tooltip with the split, `N HTTP errors, M no response` (`step.httpErrors` / `step.noResponse`); a report stored before the engine reported them shows the bare count with no tooltip. The **Tests** column is the deferred per-step validation - each step's own post-request script replayed after the run against that step's sampled responses - and shows a dash, never a `0`, for a step that asserted nothing: the engine omits the object rather than writing zeros, because "no assertions" and "no failures" are different answers. A step's non-script elements - extractors, assertions, timers - each get their own row beneath the step's, tallied across every virtual user and iteration (`step.elements`, issue #1495); an element that never ran is omitted rather than listed at zero, the same convention `unresolvedTokens` and `tests` follow. This is the load run's counterpart to the sequential run's per-step outcomes (`ScenarioStepCard.tsx`'s `ElementOutcomes`), aggregated as counts instead of one outcome per execution because a load run has many.

> History detail reuses the live dashboard's `hero/`, `charts/`, and `stats/` components by feeding them a `DashboardDerived` built from the stored report (`reportToDerived`), so live and historical views stay visually consistent.

## Variables (`modules/variables/`)

- **Sidebar (`sidebar/VariablesCategoryTree.tsx`)** - tree of variable scopes (globals, environments, collections); fetches both lists itself, like the drawer's other views. A WAI-ARIA tree on `useRovingTreeFocus`, so the tree is one tab stop and an environment row answers F2, Delete/Backspace and Shift+F10 / Menu / Shift+Enter - Rename, Duplicate, Copy for agent (`environmentReference`, #2047) and Export as Postman Environment live only in that row's ⋯ menu and had no keyboard path before #1217. Export as Postman Environment (#2253) calls `POST /export/postman-environment` with the id alone, so secret values are written blank, downloads the file the engine names and toasts what was left out (secret values blanked, `json` variables written as `default`); a second pick is ignored until the first settles. Right-click opens that same menu through `RowContextMenu` (issue #1360), the pointer route beside the keyboard one. The section headers are the level-1 rows; "Add environment" stays a tab stop of its own, since the tree has no "create" key. See [Tree Navigation](../design-system.md#tree-navigation-roving-tabindex).
- **Main (`main/`)** - `VariablesMain.tsx` (screen `"variables"`) hosts `VariableTableEditor.tsx`, the table editor for the selected scope, including the active-environment selector.

**`VariableTableEditor` does not mount the [shared key/value table](#shared-keyvalue-editor-componentssharedkeyvalueeditor), and that exclusion is permanent** (decided in #564, re-examined and confirmed in #587). It is not a copy of that table - it is a different one: a per-row type select and secret toggle, a masked value cell, text committed on blur while toggles save immediately, and rows ordered by a `createdAt` stamp rather than by a trailing-blank rule. Mounting the primitive here would mean giving it a dynamic column model, a commit model, and variables-domain fields on `KeyValueItem`, redesigning a primitive for one consumer at the expense of its three others. What the "a hand-rolled copy of a primitive does not receive the primitive's fixes" rule *does* bind is the reveal control: `ui/secret-input` was extracted from this cell and then received fixes (the `tabIndex={-1}` removal, `aria-pressed`) the leftover copy never got, so the value cell mounts `SecretInput`. `main/key-value-parity.test.tsx` pins what the two tables must keep in common - control height, checkbox clearance and sizing, the shared `rowActionDestructive` variant, and that reveal control - each read off the primitive rather than off copied literals, so a fix to either side that skips the other fails.

**Rows carry an editor-local id, and it is what React keys them by.** Reveal state lives inside `SecretInput`, so reconciliation decides which row owns it - and while rows were keyed by array index, deleting a revealed secret handed its mounted field to the row that shifted up, which then rendered unmasked (#621). A variable has no identity of its own to key by (`key` is editable, `createdAt` may be absent), so each row is stamped with a session-monotonic id at load and at insertion. The id is UI state and is never persisted: `performSave` builds each entry field by field. A reseed of the **same** scope carries the ids over, matched by variable name - a reseed is usually the cache echo of a save this editor just made, and fresh ids there would remount every row, re-masking a revealed secret and pulling focus out of the field being typed in. A **different** scope mints fresh ids, since those are different rows that merely share names. `main/secret-reveal-identity.test.tsx` pins both halves.

**A save merges the user's edited rows onto the freshest map rather than replacing it with the editor's own copy** (#1439), through the same `lib/variable-merge.ts` primitive the context bar's `useVariableCommit` uses - see [state-management.md](state-management.md#a-variable-map-write-merges-onto-the-freshest-map-never-onto-its-own-copy). An MCP agent's `update_environment` landing on a key the table has not touched survives the next save regardless of how stale the table's own copy of that key is; a key both the user and an agent touched shows a `Callout` naming it, with a "Take theirs" action, rather than resolving silently either way.

**`main/VariableRow.tsx` is `memo`-wrapped, keyed by `variable.id`, for the same reason `KeyValueRow` is** (issue #1716). The table used to render every row inline in a `.map`, with no row component of its own, so `updateVariable` rebuilding the whole `variables` array on every keystroke re-rendered every row's `Input`, `Select` and `SecretInput` regardless of which row was typed in. `updateVariable`, `removeVariable` and the `commitNow` wrapper around the ref-held `performSave` are all in `VariableTableEditor.tsx` now id-based and ref-backed (`variablesRef`), so their identities survive a keystroke; `handleBlur` reads `hasPendingChangesRef` for the same reason, since a dependency on the `hasPendingChanges` *state* would change its identity on every dirty/clean flip and defeat every row's memo on that flip alone. Only the row whose own `variable` object actually changed re-renders - `main/variable-row-render-count.test.tsx` pins it. The row's "Copy for agent" button (`variableReference`, #2047) reads its scope from a `scope` prop that `VariableTableEditor` memoises on the owner's id and name, so it is one reference across a keystroke and does not defeat `memo`.

## Settings (`modules/settings/`)

Same nav/content split as Variables: the category tree renders in the **Drawer** (`settings` view), not inside the settings tab. Selecting a category sets `useSettingsStore.selectedCategory` **and** opens the settings tab, so `SettingsMain` shows that panel. There is no `SettingsLayout` two-pane wrapper anymore - the Drawer is the left pane.

- **Sidebar (`sidebar/SettingsCategoryTree.tsx`)** - settings category navigation and the search over every setting; rendered by the Drawer.
- **Main (`main/`)** - `SettingsMain.tsx` (screen `"settings"`) hosts the app-settings category panels under `main/panels/`: `AppearancePanel.tsx`, `DashboardPanel.tsx`, `LoadTestingPanel.tsx`, `GeneralPanel.tsx`, `McpSettingsPanel.tsx`, `NotificationsPanel.tsx`, `EditorPanel.tsx`, `KeyboardShortcutsPanel.tsx` and `FilesPanel.tsx` (Settings > Files: the engine's allowed folders for request-body files, added only through the system folder picker - `electronAPI.allowFolder` through `hooks/useAllowFolder.ts`, which main allows with the grant secret (#2356), so there is no typed-path field - and removed), plus the shared `ClientSettingsPanel.tsx` wrapper, `FontPicker.tsx`, and `SettingControls.tsx` primitives. The pick-one tile grids (`OptionButtons`, and the font tiles including "Custom…") are one radio group built on the Radix `ToggleGroup` primitive directly (`TileGroup` / `TileItem` in `SettingControls.tsx`, not the segmented `ui/toggle-group`): each tile is a `role="radio"` with `aria-checked`, arrow keys move the selection with the focus (the WAI-ARIA radio pattern; Radix roves focus only, so `TileGroup` adds the pick for focus that follows a key press and leaves a pointer press to Radix's click), and pressing the chosen tile again does not clear it (issue #1865). The group is named by its setting: `label` is a required prop on `OptionButtons`, `FontPicker` and `TileGroup` (the `aria-label` on the `radiogroup`), and each call site passes the same constant its visible heading renders (`THEME_MODE.label`), so a screen reader hears "Theme, radio group" rather than an anonymous run of radios (issue #1997). `NotificationsPanel.tsx` now carries two cards: the opt-in for OS notifications while Vayu is in the background, and the four toast preferences (issue #1358). Each card carries exactly one **Preview**, and they are deliberately the same control - same word, same icon, same row under the settings it demonstrates, and the same shape of hint when it cannot fire (a severity floor on one, a build that cannot post on the other). Only the accessible name separates them, since a screen reader hearing "Preview" twice on one screen learns nothing. The system one is disabled while its toggle is off, the same as the toast one is while its severity floor hides everything: trying it means turning the setting on, pressing Preview, and turning it off again if it does not fit, rather than a button that contradicts the switch beside it. `GeneralPanel` composes three cards of its own: `UpdatesCard.tsx`, `StartAtLoginCard.tsx` and `CookiesCard.tsx` (the engine's cookie jar - what it holds per environment, and the button that empties it). `StartAtLoginCard` is the switch for opening Vayu at login (issue #2098): the value lives in the OS and is read through `electronAPI.getLoginItem` on mount and after every `setLoginItem`, never held in a store. The card always renders, with its search anchor; where the main process says the switch cannot work (an unpackaged build) it prints the reason, and outside Electron it prints a one-line fallback, each with no switch. A login item macOS holds for approval adds a hint pointing at System Settings > General > Login Items. Its Data management card's **Clear run history** is one `DELETE /runs` (`apiService.clearRuns`, #2429): the engine keeps a pinned baseline and a run still in flight, so `planClear` reads the same split from the cached list ahead of the call. The confirm dialog counts only the runs that will go and names what is kept ("One pinned baseline is kept.", "One run still in progress is kept."), the button is disabled with a reason when nothing but those is stored, and the tabs that close are the `deletedIds` the engine answers with. Its Storage paths card's Logs row carries an Open button (`electronAPI.openLogsFolder`, issue #1558) beside the path text - `<data-dir>/logs/` holds `engine_*.log`, `cli_*.log` and the app's own `app_*.log` side by side, and a failure to open it (no file manager configured) becomes a toast rather than a silent no-op; absent, not disabled, outside Electron. `app-panels.ts` is the panel registry/metadata and `main/app-panel-components.ts` the map from a category to its component - two files rather than one because the registry is read by the Drawer's category tree and the command registry, both mounted on every tab, so a component named there loads at startup rather than with the settings surface (#1146). `app-settings.ts` is the catalogue of the settings inside those panels and of the engine categories' `Cards` (see Search), and `engine-categories.ts` the engine-side registry. An engine category may also declare `Cards` - components rendered above its `/config` entries, in order, for engine surfaces the generic entry renderer cannot draw because `GET /config` does not describe them; Network & connectivity declares `ClientCertificatesCard.tsx`, the host-to-certificate registry for mTLS endpoints (issue #707), and `ConnectionTestCard.tsx`, which sends one request under the settings on that screen and reports which hop answered - proxy, TLS or the endpoint (issue #708). Both read their anchor and heading from the `app-settings.ts` catalogue (`panel: "network_performance"`), which is what makes them searchable: no `/config` entry describes them (issue #1869). The test card also holds this screen's half of system-proxy resolution (`useSystemProxyRefresh`), so the resolved `proxySystemUrl` row above it is true for whoever is reading it. (The former monolithic `UISettingsPanel.tsx` was split into these panels in PR #55.)

**`AppearancePanel`'s Interface card carries a Density toggle** (issue #1670): `Default` and `Comfortable`, from `UI_DENSITIES` (`constants/appearance.ts`) and rendered through the same `OptionButtons` primitive as Roundedness. `useAppearance`'s `density`/`setDensity` persist the choice under `STORAGE_KEYS.UI_DENSITY` and call `applyDensity` (`stores/appearance-store.ts`), which sets `data-density` on `documentElement` before first paint - the pattern `setTheme` and `applyRadius` already use for the other appearance stores. `index.css`'s `[data-density="comfortable"]` rule is what actually moves the layout: it restores the `--spacing` value Tailwind defaulted to before this setting existed, so Comfortable reproduces 0.30.0's spacing and row heights exactly, while Default is the denser value every other Tailwind spacing utility in the app now computes against.

**Density scales rhythm, not chrome, interactive targets or icons** (issue #1679, superseding #1676's "the shrink applies to icons too" decision). A chrome band (the tab strip, drawer header, notification banners), an interactive target (a button, a checkbox, a toggle) and an icon each carry their own floor - ten named steps outside the `--spacing` multiplier, `--spacing-band`/`-band-md`/`-band-lg`/`-banner`/`-control`/`-control-sm`/`-control-xs`/`-target`/`-icon`/`-icon-sm` in a plain `@theme` block in `index.css` (not `@theme inline`, which bakes a literal into each generated utility rather than a `var()` reference and would silently disable the Comfortable override) - so Comfortable no longer means "the tab strip and the toggle switches get taller too" the way #1670's single unit implied. See [Chrome, Target and Icon Floors](../design-system.md#chrome-target-and-icon-floors) for the values and which components read which step, and [Spacing Scale Conventions](../design-system.md#spacing-scale-conventions) for the rhythm unit itself.

The engine categories render from `GET /config` metadata alone - no per-key branching in the component. Two flags on each entry shape the screen: `requiresRestart` draws the "Restart Required" chip (and, once saved, the "Pending" chip plus the banner and the Dock's signal), and `advanced` moves the entry into a collapsed **Advanced** section at the bottom of its category. Both are read as fields; the `"(Requires Restart)"` label substring they replaced is gone, and `config_route_test.cpp` guards it from coming back. The collapsed state is deliberately not persisted, and resets when the category changes.

**Units come from the entry, not from the key.** `ConfigEntry.unit` (`ms`, `sec`, `days`, `bytes`; absent for a count) is passed straight to `NumberSettingRow`'s `unit` prop, which renders it inside the input - the one place a unit is stated, so no label appends `(ms)` and no description spells it out. `bytes` also selects `formatBytes` / `formatSizeRange` for the value, the range hint and the default line, so `104857600` reads as `100.0 MB`; anything else is shown verbatim, and a unit this app has not heard of still reaches the screen. That last branch used to be `isSizeConfig`, a hardcoded list of three keys in `utils/format-size.ts` - the app re-deriving what the engine owns, so a byte-valued entry seeded engine-side rendered a bare number until someone edited the array (and two retired keys sat in it unnoticed). The list is gone; `isByteUnit(entry.unit)` reads the declaration. Entries sort **by label**, not by key: the key is an internal name, and seed order is not a stable alternative because the engine rewrites a changed setting with `INSERT OR REPLACE`, which reassigns its rowid.

**A `dependsOn` entry nests under the entry it names, out of the label sort** (issue #1610). `correlationIdHeader` carries `dependsOn: "correlationIdEnabled"` because the header means nothing until the id is switched on, and the label sort above once put every entry from D through R between the two. `SettingsMain`'s `nestDependents` sorts everything with no `dependsOn` by label as before, then splices each dependent immediately after the parent it names, indented (`ml-6`) and rendered with its control disabled and a "Turn on \<parent label\> to use this" hint while the parent reads `"false"` - read live off the parent's own (possibly unsaved) value, so toggling the switch enables the dependent before the page is saved. A dependent whose named parent is missing from the payload renders standalone at its own alphabetical place rather than vanishing.

**`KeyboardShortcutsPanel` is the registry, drawn** (#951). Every row comes from `SHORTCUT_GROUPS` in `constants/shortcuts.ts`, its name from that chord's own `label` field, and its key-caps from `chordKeys` - the same function `ActivityRail`'s tooltips render through, so the screen cannot advertise a chord the handler does not listen for or spell a modifier the platform module would spell differently. A second table of names and keys here is the exact defect #938 removed from the Shell. It is read-only: rebinding needs a store, a persistence format, a conflict check against the native menu and a matcher that reads user data, and #951 scoped this to the list. Adding a chord means adding it to a group in that file; `shortcuts.listed.test.ts` walks the registry's exports and fails when a declared chord reaches no group or carries no label, and `KeyboardShortcutsPanel.test.tsx` compares the rendered row count to the registry's own. The palette reaches the screen through the section command the registry already generates from `APP_SETTINGS_PANELS` - no palette entry of its own, so there is one place a shortcuts row is defined.

Adding an app panel is four edits and no branching: a member on `ClientSettingsCategory` (`types/domain.ts`), one entry in `APP_SETTINGS_PANELS`, the panel file, and its line in `main/app-panel-components.ts` - which the compiler demands, since that map is keyed by `ClientSettingsCategory`. The sidebar tree and `SettingsMain` both read the registry. The engine half works the same way: `ENGINE_SETTINGS_CATEGORIES` (`modules/settings/engine-categories.ts`) carries each category's label, description, icon and sidebar order, and both the tree and the settings header render from it - they used to hold two hand-maintained maps of the same five names.

**The six engine categories** (#586), in sidebar order, which is by likelihood of visit rather than by seed order: **Core** (base capacity, threading, storage internals), **Network & connectivity**, **Services** (streaming requests, webhook inboxes, mock servers, OAuth issuers - the Dock's word for that group, and its `Radio` icon), **Observability** (server monitoring and live metrics), **Data & retention** (capture and truncation budgets, run retention: `maxRunsRetained` for load and collection runs, `maxDesignRunsRetained` for design Sends, `runRetentionDays` for every kind), **Scripting environment**. Labels are sentence case, matching the app panels they sit under in the same sidebar. The set is closed on the engine side too - a seeded entry in a category this registry does not declare is dropped from the index and rendered nowhere, which `config_route_test.cpp` pins against the seed. "Observability & Data" held 24 of 48 entries before the split; "Database Performance" was a sidebar row for three, and folded into Core. App-side, the MCP panel reads **AI agents (MCP)** - the sidebar's only unexpanded acronym, kept in the parenthetical so it stays findable by eye.

**One knob, one editor.** A `/config` entry whose editor is an app panel row is listed in `ENGINE_SETTINGS_EDITED_IN_APP` (`modules/settings/engine-settings-edited-in-app.ts`) and drops out of the engine list: `liveReplayWindowMs` rendered both as "Live Chart Window" here (staged edit, Save bar) and as "Chart window" in Dashboard (autosave option buttons), so one value carried two labels, two save models and two search results, and staging one while flipping the other left this row showing a value nobody saved. The entry stays seeded, on `GET /config` and writable through `POST /config` and MCP; only the second editor is gone. Search folds the engine key into the owning row's keywords rather than indexing it separately, so `liveReplayWindowMs` - the name the docs, the logs and `update_config` use - still finds the setting, lands on the row that edits it, and returns one result. Related: General > Data management links to Engine > Data & retention, because that card shows and clears stored runs while the knobs bounding them live in the other section.

### Search

`lib/settings-index.ts` is a **pure** module: `buildSettingsIndex` flattens three catalogues into one list - the app panels (`app-panels.ts`), the settings inside them and inside the engine categories' `Cards` (`app-settings.ts`, whose `panel` may be an engine category) and the engine entries from `GET /config` - and `searchSettings` filters and ranks it (label, then id, then keywords, then description, then category label; an empty query means "not searching" and returns everything). It is deliberately free of React and stores.

`modules/settings/useSettingsIndex.ts` is the half that names the catalogues and reads the `/config` query. Both consumers call it - the sidebar's search box and the palette's `useSettingsItems` source - rather than each assembling the four inputs inline, which is the "one branch defines it, the other re-derives it" wiring defect this repo keeps finding. One index, one ranking, two UIs. The sidebar's query text lives in `settings-store` (`searchQuery`) for the same reason the index is shared: the palette's escape row hands its query over, so the drawer opens already filtered.

**Index the settings, not the screens.** The first version held panel titles and engine entries only, and a user searching "theme", "color" or "font" got nothing - the panel that holds all three is called "Appearance" and describes itself as "the look and feel of the application". `app-settings.ts` is the app-side catalogue that fixes it: one `AppSettingDescriptor` per setting (`anchor`, `panel`, `label`, `searchText`, optional `keywords` for the words a user types that the copy never uses - "dark mode", "accent", "zoom"). A new app setting needs an entry here, or it is unfindable - and so does a new `Card` on an engine category, whose descriptor names the engine category as its `panel` because no `/config` entry will ever index it.

**Both halves carry keywords, and neither renders them.** The engine sends its own on each `/config` entry (`ConfigEntry.keywords`, always an array, empty for the entries that declare none) - "ram" for `dbCacheSize`, "deadline" for `defaultTimeout` - so an engine setting is findable by a word that is in neither its label nor its description, which it was not while the index passed `[]` for that half. The field is a match term and has no reader in any component: it is the one deliberate exception to "grep for a reader before adding a field", and both type declarations say so. Adding a keyword that repeats a word the entry already carries is a defect, not a freebie - label, id and description all rank above keywords, so the duplicate only lifts the entry over better matches; the engine guards its seeds with a test.

**The catalogue owns the name; the panel owns the prose.** `label` is not a description of the heading, it *is* the heading - every panel renders `appSetting("<anchor>").label` rather than typing the string a second time, so a rename happens once and reaches both the screen and the search result. That is why the labels read as they do ("Font", not "Interface font"): the result row already prints the owning panel underneath, so qualifying the name here would only offer a title the panel never shows, and the qualifier a user might still type goes in `keywords` instead. `searchText` is the one field that stays hand-written, and it is **match text, not display text** - nothing renders it. A panel's own copy is markup (`<Kbd>` chips, live counts, conditional notices), so there is no string to lend; the catalogue writes a one-sentence summary of the block instead.

Both halves are checked rather than trusted, by `app-settings.drift.test.tsx`, which renders every panel and every engine category's `Cards`: a declared `anchor` has to be on screen (it is the `data-setting-anchor` the panel puts on the block), and the block's heading has to equal the declared `label` **exactly** - "Theme Modes" contains "Theme Mode", and a guard that accepts that is not a guard. A heading is one of four shapes and the block cannot say which, so the test resolves them in reading order: a row that names itself (`data-setting-row`, which `NumberSettingRow` and `ToggleRow` write from the same prop they print), then a `CardTitle`, then an `Eyebrow`, then a row nested inside. Rendered, not source-scanned - both the anchor and the label arrive through props, which no scan of a panel file would see.

Revealing a result is one mechanism for both halves: the sidebar passes the result's `anchor` as `useSettingsStore.highlightedKey`, and `useRevealedSetting` (mounted by `SettingsMain` and by `ClientSettingsPanel`) finds `[data-setting-anchor="<key>"]`, outlines it for `HIGHLIGHT_MS` and clears the key. It waits for the block through a `MutationObserver`, because the panel usually mounts after the key arrives. The one thing the attribute cannot do stays in `SettingsMain`: an entry inside the collapsed **Advanced** group is uncollapsed first, or there would be nothing to reveal.

**It scrolls the pane's own scroller, never `scrollIntoView` on the anchor** (#1612). Both panels wrap their cards in a `[data-setting-scroller]` div nested inside `overflow-hidden` columns (the pane itself and the shell around it); `Element.scrollIntoView` walks *every* scrollable ancestor until the target is satisfied, and Chromium counts `overflow: hidden` as scrollable for that purpose even though no user gesture can move it back - so a call that needed more travel than the inner scroller had left pushed the category header (with Reset to Defaults / Save Changes) out of the pane for good. `scrollWithin` (`@/lib/scroll-within`) instead finds the nearest `[data-setting-scroller]` ancestor and scrolls only that container, computed from `getBoundingClientRect`. An anchor with no such ancestor is not scrolled at all, rather than falling back to a guess. `SchemaExplorer`'s own reveal-on-search uses the same helper against its own list container, for the identical reason.

### Row primitives and save models

`SettingControls.tsx` holds the shapes every panel shares, and panels use them rather than re-rolling one - a hand-rolled copy never receives the primitive's fixes. Their reach is not the settings screen: the request builder's [Settings tab](#request-builder-modulesrequest-builder) renders three of them (issue #702), which is why a change here is checked against that tab too.

- `OptionButtons` - the pick-one tile grid. `preview: (isSelected) => ReactNode` per option draws the theme badge, the accent swatch or the roundedness shape, so Appearance no longer re-implements the selected-card style three times.
- `ToggleRow` - label (a node, for the MCP tool rows' `<code>` and counts), description, `disabled`, `title`. Takes an `anchor` like `NumberSettingRow` does, for the switches search reveals individually (Word wrap, Line numbers, Minimap), and names its box with `data-setting-row` from the same string that names the switch. A string label is wired to the switch with `htmlFor`/`id` as well as naming it through `aria-label`, so the words are part of the hit area - a Radix switch is a `<button>`, which is labelable; a node label has no text to associate, which is what `ariaLabel` is for.
- `NumberSettingRow` - input, unit suffix, range hint, `aria-invalid` + message, and the Default line. Its `commit` prop is the one thing the four old copies really disagreed about: `"change"` for settings that apply live, `"blur"` for owners that do real work per write (the MCP caps cross IPC). An unparseable draft is never committed - it stays in the field until it is a number again. The description is pointed at with `aria-describedby` rather than only rendered (both ids, in reading order, when there is an error too), because a description like "Only applies while Follow redirects is on" is the reason the field is disabled. `data-setting-row` names the row's box. `compact` is the opt-in denser variant the element card's schema-generated form uses (`text-xs` label, `size="sm"` input, no width cap, so the field fills a half-width grid column) - opt-in because the settings panels are read one row at a time and keep the roomier default.
- `SelectSettingRow` - the pick-one row as a dropdown, for a set that reads as a list rather than a tile grid: `OptionButtons` stays the default where a user browses three or four choices, and this is for a value they already know the name of (the request tab's **Protocol**). `useId` pairs the visible label with the trigger and names it, because the trigger's text is the *chosen option*, not the setting. `onChange` hands back a `string` - a `Select` cannot promise the owner's union, so the owner narrows it (`isHttpVersion`) and decides what an unknown value means. Its second consumer is the engine view's `enum` card (`defaultHttpVersion`, `dbSynchronous`, `proxyMode`), which wrote the same row out by hand until issue #747: there the `CardTitle` is the setting's name, so it passes `labelHidden` and the label goes `sr-only` rather than away - it is what names the trigger, exactly as on `NumberSettingRow`. The trigger's width belongs to the row rather than to either caller (`w-48`, where `NumberSettingRow`'s input already stops), so the two control types end at the same place down a card; the engine's longest option label, "From environment", fits it. The card keeps its own guard for an entry whose `options` the engine omitted - rendering nothing is deliberate, and the primitive does not learn about it. It takes `compact` too, alongside `NumberSettingRow`, which drops `w-48` for the same reason that row drops its input cap.
- `DefaultValueLine` - "Default: x" plus the reset that goes there. Used by `NumberSettingRow` and by the boolean/enum/string engine cards, so every entry type has one.
- `CollapsibleText` - a description that reads as one or two lines with a "Show more"/"Show less" toggle, for the engine's per-setting `CardDescription` (every `/config` entry across all six categories) and the MCP panel's card and per-tool descriptions, both of which run to full paragraphs. Character-counted against a clamp rather than a CSS `line-clamp` plus a measured overflow, since jsdom lays out nothing for a test to measure. Callers pass the plain-string description as `text`; a description built from JSX (the Allowlist card's inline `<code>` spans) is left outside this primitive rather than forced through it.

Three save models coexist and each says which it is: app panels state `AppSettingsPanel.saveNote` (defaulting to `DEFAULT_SAVE_NOTE`, "Changes are saved automatically.") in the `ClientSettingsPanel` header, MCP overrides it, and the engine view states its staged-then-saved model beside the Save bar. Leaving an engine category still flushes its staged edits, and now **says** when one was dropped for being invalid instead of discarding it silently. A card's Revert discards a staged edit; Reset goes to the shipped default - one name each, for the two different things.

`LoadTestingPanel.tsx` is the ceilings the load-test dialog offers - the app's own policy, clamped to the engine's crash guards on the way into `client-settings-store`. The engine's bounds themselves are deliberately **not** settings; see `docs/app/api-integration.md` (Dialog ceilings are a user setting).

## Webhook Inbox (`modules/inbox/`)

The receiving half of the app (issue #480): an engine-hosted listener that records the requests
sent to it, so building a webhook consumer needs no cloud tunnel. Engine contract:
`docs/engine/api-reference.md` (Webhook Inbox).

- `index.tsx` (`InboxView`, screen `"inbox"`) - start/stop/clear/delete, the URL with a copy
  control and a text **Copy for agent** button (`inboxReference`, #2047), the running/live badge, the `Notify` toggle (`NotifyOnCaptureToggle`, whose two gates
  are `capture-notifier.ts` below), the inbox switcher, the capture list and the detail pane. Clear
  (Eraser) empties the capture list; Delete (bin) ends the inbox itself, so the two adjacent
  destructive controls do not share an icon. The first fetch of the capture list shows a
  `ListSkeleton` (the count dashes and Clear waits) rather than "No captures yet.", which an
  in-flight query would otherwise be indistinguishable from (#1928). The switcher is a
  `Select` in the header, shown only when more than one inbox exists (with one, it could pick only
  what is already on screen) and ordered by port - the engine lists in map order, which is not
  stable across polls, and a switcher whose entries move under the pointer is worse than none. An
  inbox record carries no creation stamp and does not gain one - #555 answered that, and the
  Services drawer orders by port for the same reason. Every mutation this tab owns reports its
  failure as a toast (`reportFailure`), which is the one discipline the whole inbox lifecycle
  follows; Stop and Clear used to pass no `onError` at all (#555, item 7 - taken there rather than in
  #556's tab pass, which both issues named as the shared brush). The header's copy control answers
  to the same discipline through the shared `useCopy` (see [Services](#services-modulesservices)) -
  it is not a mutation, but it is the other thing here that can fail, and it claimed success
  regardless until #565. The URL button is an icon button, so a landed copy swaps its glyph to a check
  and raises no toast (`useCopy({ feedback: "icon" })`, #2315); the "Copy for agent" text button beside
  it keeps its own plain `useCopy()` and toasts.
- `InboxStartOptions.tsx` - the secondary start path (issue #2367): an **Inbox options** icon button
  beside every Start (the tab's empty state and its stopped-inbox **Start new**, and the Services
  drawer's **New inbox**) opening a dialog with the **Allowed origins** box. The one-click start
  stays one click and sends `{}`; the dialog is the only way a list reaches the engine. It owns its
  own start mutation, since the three places that offer it react to a start differently (`onStarted`),
  and shows an engine refusal as a `Callout` in the form. The header of `InboxView` states the
  policy the engine echoes (`Origins: any` or the list) for the default too.
- `CannedResponseControls.tsx` - all four fields the engine serves: reply status and delay inline,
  body and headers behind a disclosure that opens on its own when either is set. It showed status and
  delay only, so a reply body or header set configured by an MCP tool or a bare curl was invisible
  and uneditable here (issue #556). Its own component so every field can be a draft (typing `50` on
  the way to `500` must not push a 50 at the next caller) and so re-seeding them from the engine is a
  remount - `InboxView` keys it on `cannedResponseKey`, which covers all four - rather than a
  `setState` inside an effect. Apply sends the whole response, not a diff: `PUT /inbox/:id` is a
  merge-patch, so an omitted `headers` is how a header the user deleted comes back. On a **stopped**
  inbox every control is disabled and says why - the route still merge-patches a stopped record, so
  a live-looking panel there is an edit accepted for a reply nothing will ever send. Apply reports
  through the save store like every other explicit save (issue #1450): it dims once the drafts match
  what the engine last served, and a press moves the Dock through its Saving/Saved or error states
  instead of a bare success-free toast; the reply is also a registered `useDraftSaveContext`, so a
  quit mid-apply or Ctrl/Cmd+S reaches it. The hint under the controls is a full-width line, never a
  sibling in the controls' own flex row, per `docs/design-system.md`'s hint-stacking rule. The reply
  headers are
  [`KeyValueEditor`](#shared-keyvalue-editor-componentssharedkeyvalueeditor) rows, with no `variables` scope
  passed - a canned reply is echoed verbatim, so there is nothing to resolve. They were local
  `Input` pairs until #564 made the primitive mountable outside `RequestBuilderProvider`; the
  table's trailing blank row replaced the panel's own "Add header" button. Header names complete
  from the same `STANDARD_HEADERS` list as the request builder's Headers tab (#1449) - the mount
  had reused the primitive without its header-specific suggestion prop.
- `capture-notifier.ts` - the OS notification a capture raises while Vayu is in the background
  (issue #1388), and the two gates it passes first: the global opt-in, read by `services/notify.ts`
  for every kind, and this inbox's own `Notify` toggle in the header, read here and off by default.
  Both, because a webhook source sets the rate and a busy inbox must not be made loud by the setting
  the user turned on for run results. One window of captures is one notification naming how many
  arrived, through `createThrottledBatcher` with its leading edge off - a leading edge would post
  once for the first capture and once for the rest, which is two notifications for one burst. The
  window is trailing for that reason and not a setting: it is a property of what a notification is
  for, not of how fast this user's source is. A click opens the inbox tab the capture landed on
  (`target: { view: "inbox", inboxId }`), which is why the tab retargets rather than opening a
  second one. The toggle is stored per inbox in `inbox-notify-store`, not on the engine's record:
  the engine's inbox is in-memory state that does not outlive its process and does not act on the
  flag.
- `CaptureDetail.tsx` - one capture, rendered through `UnifiedResponseViewer` and `buildRawRequest`.
  Its header row carries a **Copy for agent** icon button (`captureReference`, #2047).
  A capture is an exchange with no response, which that viewer already handles; a request you
  received should read like one you sent.
- `useInboxLive.ts` - the view's reference to the stream, not the stream itself. It retains the
  addressed inbox in `services/inbox-watch-service.ts` while the tab is mounted, renders the
  `watching` / `stopped` that service reports, and offers its Resume. Releasing the reference does
  **not** close the socket unless nothing else wants it: the tab is mounted only while it is the
  active one, and a stream that went away with it took the `Notify` toggle's whole purpose with it
  (issue #1400).
- `services/inbox-watch-service.ts` (outside this module, beside `load-test-service.ts` and for the
  same reason) - the sockets. One `EventSource` per watched inbox, opened for the union of the
  inboxes a mounted view has retained and the running inboxes whose `Notify` toggle is on, capped at
  `MAX_INBOX_WATCH_STREAMS` (8) with the inbox on screen always given a slot. Each stream owns its
  `CaptureNotifier` and merges arriving captures into the same query cache `useInboxCapturesQuery`
  fills, not a second list beside it - two lists would need reconciling on every clear, and whichever
  the detail pane read would decide which was true. The reconnect is the service's own, not the
  browser's: `EventSource` treats a non-200 as fatal, and a reconnect landing inside the engine's
  dead-socket window meets a `409`, so a single drop used to end the stream for the life of the tab.
  It retries with a jittered backoff, resumes from the last capture id it saw (`?lastEventId=`, since
  no API sets a header on a fresh connection), and once the retries are spent reports `stopped` so
  the surface can say so and offer a Resume rather than leave the badge reading `Running`. A stream
  also ends because somebody *stopped* the inbox - from the drawer, an MCP tool or curl - and that
  close is indistinguishable from a drop, so before spending a retry it refetches the inbox list and
  reads the record: gone or `running: false` means no reconnect, and the surface reflects the stop
  inside the close instead of on the next `SERVICES_POLL_INTERVAL_MS` poll. A refetch that failed
  leaves the last good list, which still says running - a blip must still retry. **What running out
  of retries costs depends on who is holding the stream** (issue #1403): a stream a view has retained
  waits for the Resume that view offers, and one held only by the standing want - which no surface
  renders, so no surface can offer anything - is handed one fresh budget
  `INBOX_LIVE_BACKGROUND_RESUME_MS` (60s) later, from a timer the service arms as it gives up, and
  again a minute after that if the new ladder is spent too. The bound is untouched: each resume buys
  one ladder, so a background stream costs at most six attempts a minute against an engine that keeps
  refusing, where a burst spends six in about fifteen seconds. The timer is the service's own rather
  than the watcher's list read, because that read stops happening in exactly the case this is for -
  `refetchIntervalInBackground` is unset (`lib/query-client.ts`), so the inbox poll pauses in a hidden
  window - and a minute is also the bucket Chromium aligns a long-hidden window's timers to, so a
  shorter cadence would not fire sooner there. The wanted set the resume runs against is therefore
  the last one the engine gave: an inbox stopped elsewhere meanwhile costs one refused connection,
  after which the listener-is-gone check above ends the stream without spending the budget. **Above
  the cap there is no such recovery**: the ninth notify-enabled inbox is left with no stream at all
  until a slot frees up, so it is not waiting for anything. Both cases - a stream that gave up, and
  an inbox the cap left out - are what `getSummary()` / `subscribeSummary()` report (issue #1412),
  the one accessor that answers for every inbox at once rather than for the one a view is showing.
  `stalled` there is held until a connection actually opens rather than cleared when the resume
  fires, so a stream that keeps failing reads as one standing state instead of blinking once a
  minute.
- `services/os-icon.ts` (also outside this module, for the same reason) - a capture arriving while
  the window is not in front is counted on the app's own icon too: a badge on the macOS Dock, a
  drawn count on the Windows taskbar overlay, nothing on Linux (issue #1364). This side only reports
  that a capture landed; whether it counts is main's, because only main tells a minimized window
  from one behind another application. The count clears when the Inbox is on screen, which
  `hooks/useOsIcon.ts` reports on that tab becoming active *and* on every window focus while it is -
  captures keep counting while the user is away from a window already showing the Inbox, so the
  second half is what stops a badge outliving the list it counts. Focus alone does not clear it.
- `hooks/useInboxWatchers.ts` (mounted once in `App.tsx`, beside `useHostSleepRecorder`) - the
  standing answer to which inboxes the service should hold, recomputed as the engine's list and the
  toggles change, plus the pruning of notify preferences whose inbox the engine no longer lists. It
  observes the inbox list only while at least one inbox may notify: that list polls every
  `SERVICES_POLL_INTERVAL_MS`, and a root observer nobody reads is what #1150 removed.
- `hooks/useRunWatchers.ts` (mounted once in `App.tsx`, beside
  `useMcpDataInvalidation`) - the app's answer to a run an MCP agent started (issue #1419). Main
  names the run and which service owns its stream on the `mcp:data-changed` event; this enters the
  same `startMonitoring` path the dashboard does, so the taskbar bar, the wake lock and the finished
  notification are the same for an agent's run as for the user's. For a load run it also reads the
  run's row and sets the dashboard's config and request from its snapshot (issue #1935). A `run`
  event that is not a start attaches nothing.
- `useInboxDeletion.ts` / `DeleteInboxDialog.tsx` - deleting an inbox (issue #553), shared with the
  Services drawer so the two surfaces cannot disagree about when the confirmation appears or what it
  says is at stake. An inbox holding captures confirms and names their count; one holding none is
  deleted outright. `capturesAtRisk` takes the higher of the record's polled `captureCount` and the
  capture total a surface already holds - the record lags a services poll behind the live stream, so
  trusting it alone would let the tab destroy a capture it is displaying.
- `utils.ts` - `captureUrl`, which rebuilds the absolute URL from the stored path and raw query, and
  `cannedResponseKey`, the remount key above.

**The capture list is paged, and says so.** The tab fetched one `INBOX_CAPTURES_PAGE_LIMIT` page and
read the engine's `hasMore` nowhere, so an inbox holding its full retained ring showed the newest 50
and was indistinguishable from one that had received 50 (issue #556). A `Load more` appends the next
page and a `Showing N of M` line makes the cut visible. The offset is the accumulated length rather
than a page counter, and that is exact rather than approximate: the stream prepends every capture
recorded since the last fetch, so what is on screen is always the newest N the engine holds and the
next unseen one sits at exactly N. `hasMore` is the page's answer **and** the accumulated one - a
refetch of the first page reports "this inbox holds more than one page", which says nothing about
whether the list has already loaded it.

**One cache entry, three writers.** The first fetch, the load-more pages and the live stream all
write `queryKeys.inbox.captures(id)`, so every write is a union by capture id (`mergeCaptures` in
`queries/inbox.ts`, with `mergeCapture` for the single streamed one). That is also why a fetch reads
the cache *after* it resolves and merges into it: replacing meant a capture the stream delivered
while the GET was in flight was overwritten when the GET landed, vanishing from a list that had
already shown it. The one writer that must not union is a **clear** - it empties the cache entry
before invalidating, so the refetch has nothing to merge the destroyed rows back onto.

A capture whose body the engine only kept a prefix of is marked in the row as well as in the detail
pane: scanning the list for the payload that broke something, a row printing bytes alone is a row
that does not say its body is a prefix.

**One tab, not one per inbox.** An inbox is engine-process state with no id worth restoring into a
tab, and the engine permits a single live stream per inbox (each holds a pool thread), so a surface
watching several at once would spend threads on lists nobody reads. The tab is a singleton and is
never dirty - both stated explicitly in `tabs-store`, since a *missing* answer reads the same as
"clean" and is what once made a dirty Settings tab LRU-evictable
(`components/layout/tab-type-coverage.test.ts` guards all three switches).

**One tab, but a retargetable one.** The tab's own `entityId` is the address of the inbox it shows,
and `openTab` on an already-open singleton with a different `entityId` moves that tab rather than
just focusing it (`tabs-store`). Both writers go through it - a drawer row and the header's
switcher - so there is exactly one record of which inbox is on screen. Before this the tab had no
address at all: it showed whichever inbox its own start mutation had last named, falling back to
the first the engine listed, so a row labelled "Open inbox on port B" opened a tab showing A
(issue #554). An address the engine no longer lists (a tab restored across an engine restart)
falls back to the lowest-numbered port.

**Entry points:** the **Services** drawer view, which lists every inbox and opens this tab (issue
#502), and the palette's `Inbox` entry. The welcome Launcher's tile is now `Services` rather than
`Inbox` - it teaches where the whole family of local services lives instead of opening one tab -
and the Dock's running-services indicator reveals the same view. Until #502 the Launcher tile was
the *only* way in, and a running inbox was invisible once its tab was closed. The **OS** Dock or
taskbar icon - not the in-app Dock this paragraph otherwise means - is one more pointer back: its
unread count is what says a capture arrived at all when no Vayu window is in front (issue #1364).

## Services (`modules/services/`)

One home for the app's **local services** - the things that keep listening after you switch tabs
(issue #502). Rendered as the `services` drawer view; the Dock's indicator and the welcome tile
both reveal it.

- `ServicesPanel.tsx` - the view. Three groups: **Webhook inboxes**, **OAuth issuers** and **Mock
  servers**, each with a one-sentence empty state saying what the service would give you - this
  drawer is also the features' discoverability. The first two carry their own start affordance in
  the group header; the third deliberately does not (see below). An inbox row opens the
  inbox *tab* (the drawer lists, the tab shows the captures) and carries copy, stop (running rows
  only) and **delete** (every row) in one hover-revealed `⋯` menu, `RowActionsMenu` like every other
  row in the app - these were the last rows painting their actions as always-visible icon buttons,
  which on a 32px row truncated the URL that is the row's own payload (issue #1690); the URLs those
  buttons carried in tooltips ride the items' `hint`, so they read without hovering; an issuer row expands in place to its token and authorize URLs,
  a copy for the HS256 signing key, its configuration in one line, a live `failureMode` switch, and
  - in `slow` only - the delay that mode answers after, committed on blur rather than per keystroke.
  The inbox group's affordance is **New inbox** (Plus), matching **New issuer**: it always mints a
  new listener, and as a Play labelled "Start inbox" beside a stopped row it read as "restart that
  one", which nothing here does (issue #553). Beside it is **Inbox options**, the secondary start path
  that sets the inbox's allowed origins (#2367, `modules/inbox/InboxStartOptions.tsx`). **An inbox or
  mock row marks a restricted CORS policy** (`2 origins`, the list in its `title`) and says nothing for
  the default: the row is 32px and its payload is a URL, so "Any origin" on every row would only
  spend the URL's width repeating what an absent mark already says. The tabs state the policy either
  way.

  **An inbox row also says when its `Notify` toggle is not in effect** - a *Not notifying* chip
  (issue #1412), from `useInboxWatchSummary` over the watch service's `getSummary`. Two causes, one
  chip: a stream that gave up and has not opened since, and an inbox `MAX_INBOX_WATCH_STREAMS` left
  without a stream at all. They differ in what will fix them - the first is retrying on its own and
  needs nothing, the second will not change until an inbox stops or a toggle goes off - and that
  difference is this paragraph rather than a longer chip: the row is 32px, and the cause spelled out
  filled it and truncated the URL beside it to two characters. It is **this** surface rather than the
  inbox tab because the toggle exists to speak while the user is somewhere else: a note only the
  inbox tab renders is a note they have to go looking for. It appears for neither an inbox whose
  toggle is off (there is no promise to break) nor one that is stopped (it captures nothing).

  **Mock servers (#481 phase 2) have no start affordance here, and that is not an omission**: a
  mock needs a collection to serve, and this drawer has none selected. The collection header owns
  the start (`CollectionDetail/MockServerControl`); this group owns the list, so a mock started from
  any collection - or from an MCP tool, or curl - can be found and stopped where every other running
  listener is. A mock row leads with the **collection name** (two mocks of one collection differ
  only by port) and **opens the `mock-server` tab** (issue #481 phase 3, `modules/mock-server/`)
  rather than expanding in place - the same shape the inbox row already used, taken once a mock also
  kept a live activity log and not just a start-time route table. Stopping a mock removes it from
  the list, like an issuer and unlike an inbox, because a mock holds nothing that outlives its
  listener.

  **Every service row offers "Copy for agent"** (#2047) beside its URL copy: the inbox, issuer and mock
  server references (`lib/agent-reference.ts`), placed before the destructive Stop or Delete, with
  the line as the item's `hint`. The reference names the service by port and id and carries neither
  the URL nor the signing key.

  Row semantics, all from issue #555. An inbox row **leads with `Port NNNN`** and demotes the URL
  behind it: the port is the part that varies and the part a user names an inbox by, while three
  full URLs are three near-identical monospace strings differing in one digit. The URL is still on
  the row and also rides the copy control's tooltip, which says so when the inbox is **stopped** -
  a stopped inbox's URL copies perfectly well and then refuses connections, a long way from the
  cause. Every copy control here goes through the shared `useCopy` hook (`hooks/useCopy.ts`), which
  **awaits** `writeText` and toasts the failure: the promise rejects on a denied permission or an
  unfocused document, and a `void` call with an unconditional "copied" reports a refusal as a
  success while the rejection goes unhandled. It is a shared hook rather than a local one because
  the inbox tab's header offers the same URL and kept that exact defect after the drawer's fix
  (#555 item 6, then #565 item 1) - a hand-rolled copy does not receive the primitive's fixes. A row's
  `⋯` menu items toast; the icon buttons inside an expanded issuer (token URL, authorize URL, signing
  key) each own a `useCopy({ feedback: "icon" })` and swap their glyph to a check instead (#2315). Rows are ordered **by port**, because the engine lists them in map order (not stable across
  polls) and the record carries no creation stamp; the inbox tab's switcher orders the same way.
  Creating one **toasts and flashes** the new row for `TIMING.ROW_FLASH_MS` - it lands wherever its
  ephemeral port sorts, not at the end. The activator's verb is `sr-only` text **prefixed to** the
  row's content, never an `aria-label`: a label *replaces* the content in the accessible name, so
  the URL, `Stopped`, and the reachable-beyond-this-machine badge were all inaudible and a stopped
  row read identically to a running one.

  **No user-editable inbox name** (#555's stated decision point, answered *no*). A name would be an
  engine field - `InboxInfo` carries none, so it would need storage, a `PUT /inbox/:id` key and a
  wire-shape change - to label something whose whole identity is already the port it holds. `Port
  NNNN` ships instead and needs nothing from the engine. Revisit only if inboxes ever outlive the
  engine process, where a port is no longer a stable name.
- `NewIssuerDialog.tsx` - the start form: token lifetime, failure mode (plus its delay), and a JSON
  claims box. Everything is validated before it is sent, because the engine refuses a bad config
  with a `400` rather than falling back to a default, and a claims typo is otherwise invisible until
  a token comes back without the claim. Every refusal **names its bound in words**: a reddened field
  beside a greyed-out Start says something is wrong and never which field or why, and `aria-invalid`
  alone announces "invalid" with no correction. Mounted only while open, so the mount is the reset.
- `useRunningServices.ts` - `useRunningServices()` and the count derived from it, shared by the
  drawer, the Dock and the main process. One place because the three lists disagree on their own
  terms: a stopped inbox stays listed with `running: false`, while a stopped issuer or mock server
  is gone from the engine's list entirely - and because a **disconnected engine is running none of
  them**, which is the gate this hook holds so that no caller renders a green count off a stale
  cache (issue #555). The mock-server list was missing from the sum until issue #792, so a mock
  holding a port counted as nothing. The count is now the list's length rather than a second sum
  (issue #1363): the Dock saying 2 while the close dialog names 3 is a disagreement no test that
  reads one of them can see. `useRunningServicesPublisher()`, mounted once in `App.tsx`, pushes that
  list to the main process on every change.

**Closing Vayu stops everything in this drawer, and says so first** (issue #1363). These services
live in the engine and the engine goes down with the app, so a close - the X on Windows and Linux,
Quit anywhere - that would stop one asks first, naming each: the inbox by its port, the mock server
by the collection it serves. Cancel leaves them running. Closing the window on macOS asks nothing
because it stops nothing: the app keeps serving with no window until Quit.
- `failure-modes.ts` - the four `failureMode` labels, the engine's bounds, and the row's
  one-line summary. Shared so the badge, the live switch and the dialog cannot name a mode
  differently.

**No new tab type for an issuer.** Its whole management surface fits a row plus a dialog, and a
`TabType` costs three switch statements and the coverage guard. The inbox and, since #481 phase 3,
the mock server each keep a tab, because a capture list or a growing activity log needs the width -
see [Mock Server](#mock-server-modulesmock-server) below.

**Data:** `queries/inbox.ts` and `queries/mock-issuer.ts`, both polled at
`TIMING.SERVICES_POLL_INTERVAL_MS`. They are polled rather than driven by this app's own mutations
alone because the MCP tools and a bare curl reach the same engine routes - an indicator that only
knew what this window started would contradict its own promise.

## Mock Server (`modules/mock-server/`)

The detail surface for one running mock (issue #481 phase 3). Rendered for the singleton
`mock-server` tab, on the same terms as [Webhook Inbox](#webhook-inbox-modulesinbox): the Services
drawer's mock-servers row used to expand in place to a route table, which was enough while a route
table was the only thing there was to see. Once a mock also keeps a live `GET /mock/:id/activity`
log, it needs a surface that can grow while it is watched.

- `index.tsx` (`MockServerView`, screen `"mock-server"`) - the mock's base URL with a copy control
  and a text **Copy for agent** button (`mockServerReference`, #2047), the collection it serves, a stop button, an **Open collection** link back to it, and (with more
  than one mock running) a `Select` switcher ordered by port, the same reasoning `InboxView`'s
  switcher follows: the engine lists mocks in map order, which is not stable across polls, and a
  switcher whose entries move under the pointer is worse than none. Below the header, two sections:
  **Routes**, the same start-time snapshot the drawer row used to show inline (`GET
  /mock/:id/routes`, now carrying `mode`, `exampleName` and `hits` per route from Task 8's
  Examples-tab mode selection) - and **Activity**, the live feed of what the mock has actually
  served. Both poll at `TIMING.MOCK_ACTIVITY_POLL_INTERVAL_MS`: the route table's *shape* is a
  start-time snapshot, but each route's `hits` moves live as traffic arrives, so it joined the fast
  interval alongside Activity rather than the mock list's slower one.
  Each section shows a `ListSkeleton` on its first fetch, and the Routes count a dash, rather than
  "Routes (0)" or "Nothing served yet" for a query still in flight (#1928). The header also states
  the mock's CORS policy on a line of its own, `Origins: any` or the origins it was started with
  (`describeOriginPolicy`, #2367); the Services drawer row marks only a restricted mock, as a count.
- **One tab, not one per mock**, and **the tab's own `entityId` is the address**, exactly as the
  inbox tab: a mock is engine-process state with no id worth restoring across a restart, and the
  address is read from the tab rather than mirrored into local state - the drawer row and this
  view's own switcher are the only two writers, so they cannot disagree about which mock is on
  screen. An address the engine no longer lists (a tab restored after a restart, or the addressed
  mock stopped elsewhere) falls back to the lowest-numbered port, the same fallback `InboxView`
  uses.
- **Entry point:** the **Services** drawer's mock-servers group, whose row opens this tab addressed
  at the mock it names rather than expanding in place (`ServicesPanel.tsx`'s `MockServerRow`, which
  carries its own **Open mock server** action) - see [Services](#services-modulesservices).

**Data:** `queries/mock-server.ts`. The mock list is polled at `TIMING.SERVICES_POLL_INTERVAL_MS`,
for the same reason the inbox and issuer lists are: an MCP tool or a bare curl can start or stop a
mock this window did not touch. The route table and the activity log are polled at the faster
`TIMING.MOCK_ACTIVITY_POLL_INTERVAL_MS` instead, since traffic - and so `hits` - can change between
`SERVICES_POLL_INTERVAL_MS` ticks - see above.

## Welcome (`modules/welcome/`)

Vayu's new-tab surface - rendered for the `welcome` tab (opened by TabStrip's `+`), when no tab is open, and for a request tab with no entity.

It is **not** a resume screen: `openTabs`/`activeTabId` are persisted and restored, so returning users land back on their own tabs. Its job is to start something new. Keep marketing content off it - a feature pitch and static perf claims were removed for exactly that reason. The one exception is `FirstRunWelcome`, which carries a single plain sentence on what Vayu is and an agent-connect row (#2122); no figures, nothing on the Launcher. Anything already visible in the Collections sidebar or History drawer is a duplicate and does not belong here either.

- `WelcomeScreen.tsx` - container: queries, picks the state. Holds on `isLoading` so the first-run screen never flashes at a returning user. The new-request flow itself is `hooks/useNewRequest.ts`, shared with the palette's `new-request` command - two entry points must not disagree about where a request lands. This screen renders that hook's `pickerProps` and nothing more.
- `FirstRunWelcome.tsx` - fresh workspace. Import leads (people arrive carrying Postman/Insomnia/OpenAPI collections). The only state with branding. Also carries the "Connect your coding agent" row, which opens Settings on the MCP section through `lib/commands/reveal-settings.ts`'s `revealSettingsCategory` (shared with the palette's settings commands).
- `Launcher.tsx` - populated. Action row, recent runs, workspace counts. No branding; the logo is in the title bar.
- `components/` - `ActionTile`, `RecentRuns`, `FooterLinks`. The action row is six tiles: New
  request, Search, Import, History, Variables, Services. Services and History both reveal a
  drawer view (never close it) rather than opening a tab. Search opens the command palette - the
  chord alone is undiscoverable, and this grid is where the app teaches its own surfaces.
- `components/CollectionPicker.tsx` - the "Add request to" dialog, shown when a new request has no remembered collection. A nested collection shows its parent path (`collectionPath`) under its name, because two same-named folders under different parents are otherwise the same row (#1881).
- `components/DemoApiTile.tsx` - "Open Demo API" (issue #1694), its own row below the action grid
  rather than a seventh cell in it, since the grid's tiles are icon-and-label only with no room for
  "press this chord to send it". Shown only while `runs.length === 0`; retires the moment a run
  exists, with no dismiss of its own. Opens `demo-request.ts`'s preset through the same
  `useNewRequest` targeting as every other "New request" entry point.
- `LauncherSkeleton.tsx` - one skeleton tile per real tile. It has drifted a tile behind the
  Launcher before; `WelcomeScreen.test.tsx` now asserts both grids against one constant.

Doc links go through `window.electronAPI.openAppLink(key)`, a keyed IPC channel (keys in `electron/app-links.ts`) - the renderer cannot open arbitrary URLs, and a plain `<a target="_blank">` would spawn an unmanaged Electron window.

Design rationale: `app/src/modules/welcome/README.md`

## Command Palette (`modules/palette/`)

The ⌘K/Ctrl+K overlay: reach any open tab, saved request, collection or app view by name, and
run any command by name. Mounted once by `Shell`, alongside `ImportModal`.

- **`CommandPalette.tsx`** - the dialog, the chord, focus restoration, the open flag
  (`useLayoutStore.paletteOpen` / `setPaletteOpen`, deliberately not persisted), and the host
  for the dialogs its commands open (see `useCommandSurfaces.ts` below).
- **`sources/`** - one hook per family, each returning `PaletteItem[]`. Two shapes of source:
  the **shallow** ones return everything they know and let the ranking narrow it - `useTabItems` (open
  tabs), `useEntityItems` (requests + collections), `useViewItems` (drawer views and singleton
  tabs) - while the **deep** ones take the query, because their corpus is too large to render:
  `useSettingsItems` (every app setting and engine entry, through the shared settings index),
  `useVariableItems` (environment names and variable keys across every scope) and `useRunItems`
  (server-backed, `GET /runs?q=`). `commandItems.ts` is a plain function, not a hook: it owns no
  data, it maps the [command registry](#command-registry-libcommands) onto the same shape.
- **`useCommandSurfaces.ts`** - the collection picker, the run dialog, the theme hook and
  `useCopy`'s `copy`, which four commands need and no store can hold. Their original hosts are not always on screen (the
  welcome screen's picker only on the welcome tab, the tree's run dialog only while the drawer
  is open), so the palette mounts its own - the same components, driven by the same calls. It
  also merges the surfaces a *mounted feature* contributes (the request builder's live draft,
  for "Load test …" and "Send …") - see [Command Registry](#command-registry-libcommands).
- **`types.ts`** - the `PaletteItem` shape, the fixed group order, and `rankForEmptyQuery`.
- **`ranking.ts`** - what renders and in what order, decided once. See Ranking below.
- **`PaletteResults.tsx`** - grouping and rendering, and nothing else: it asks `ranking.ts` what
  to draw. **Mounted only while the palette is open**, the same cost rule the context bar applies
  to a collapsed section: a shut palette holds no query observers on collections, requests or run
  history.

Three things about it are load-bearing:

- **The chord is on the capture phase**, unlike every other shortcut in the app (which lives in
  `Shell`'s bubble-phase keydown map). Monaco treats ⌘K as the start of a chord and stops it
  propagating, so a bubble listener never sees the key while the caret is in an editor.
  `PALETTE_CHORD` lives in `constants/shortcuts.ts` so the handler and every label that
  advertises the chord read one definition. It is also the one chord declared `mod: "strict"`:
  capture phase plus a lenient modifier meant Ctrl+K on macOS - Cocoa's kill-to-end-of-line, and
  Monaco's `deleteAllRight` - opened the palette instead of reaching the focused control (#938).
- **Focus goes back where it came from**, and that is the palette's own code: Radix's
  `FocusScope` restores to a dialog's *trigger*, and a palette summoned by a chord has none, so
  focus would land on `<body>`. The previous element is captured from a store subscription
  rather than an effect - child effects run first, so by the time an effect here fires the
  dialog has already taken focus.
- **Tab rows are named by `components/layout/tab-descriptors.ts`**, the same hook `TabStrip`
  uses. A tab must not read "GET /v1/orders" in the strip and "Request" in the palette.

Ranking lives in `ranking.ts` and happens **once**. The palette declares `shouldFilter={false}`,
so cmdk scores nothing a second time; the scorer is still cmdk's own (`defaultFilter`, the
`commandScore` it would have filtered with), applied by the palette where the result can also
decide the top result, the floor and the announced count. Before #1175 both matched: each deep
source pre-selected with a ranking of its own and cmdk re-scored every rendered row, and neither
was in charge - searching "theme" surfaced 0.01-scored requests over the 0.99-scored Theme Mode
setting, because sections render in a fixed order that cmdk's cross-group re-sort cannot cross
(each is wrapped in a `div` its `appendChild` cannot reach past).

On the empty query, `rankForEmptyQuery` puts the most recent first - focus time for tabs
(`tabFocusedAt` in `tabs-store`, session-scoped), last-run time for requests (from the run history
already in cache) - and nothing is promoted, because nothing has been asked for. Two sections lead
it (#1176), and both are built here rather than by a source of their own:

- **`Recents`** - the dated rows across every kind, newest first, capped at `RECENT_LIMIT` (6, a
  glance at what you were just doing). The cap stayed at six when the list grew taller (#1177):
  the extra height went to the sections *under* Recents, which were the ones nobody could see, and
  a longer list of recents would take it straight back. It reads the same `recencyAt` the within-section
  order reads, so nothing re-derives a recency and the two cannot disagree. In practice that is
  open tabs and requests that have been sent: the deep sources contribute nothing to an empty
  query at all, so a past run reaches the list only once something is typed - where it is a
  search result rather than a recent, which is the distinction being drawn. How far back it
  reaches follows the data. Tab focus times are session-scoped by `tabs-store`'s documented
  design, so after a restart Recents is the requests the run history remembers, and fills with
  tabs again as they are used; persisting focus time to lengthen the list would rank a restored
  strip by yesterday's attention, which is the thing that rationale refuses.
- **`Quick actions`** - the `command` rows. The verbs are what an empty palette is *for*, and they
  sat fifth of eight sections, under a fold that showed about six rows before #1177 raised it.
  Typed, they rank as the `Commands` section they have always been, so the heading follows the
  query rather than the section moving around - except on a query that matched nothing, where they
  come back as the offer (#1177, below).

Both **lift** their rows out of the sections below rather than copying them into the new ones -
the same rule the top result follows, and for the same reason: two rows carrying one cmdk `value`
would both read as selected, and both would be counted. A row past the Recents cap is still
reachable in the section it was not lifted from. Neither section is a `PaletteKind`: no source
produces one, so a kind for it would be a shape nothing returns.

They lift out of **each other** too, by the order they render: Recents is built first and the
verbs exclude whatever it took (#1197). The two tests are independent - a verb is a `command` row,
a recent is one carrying a `recencyAt` stamp - so a stamped command would otherwise sit under both
headings, which is the duplicate the lift exists to prevent. No source stamps a command today, so
this decides nothing on screen; it is what keeps the first one that does from arming the defect
silently, and `ranking.test.ts` pins it.

Once something is typed, four rules apply:

- **The best match is promoted to a `Top result` section**, lifted out of its own section rather
  than copied into the new one: two rows carrying the same `value` would both read as selected.
  Ties go to the earlier section. Below it, groups render in the same fixed order as ever (Tabs,
  Requests, Collections, Views, Commands, Settings, Variables, Runs) so the list does not reshuffle
  as you type; within a section, rows are ordered by score, with the source's own order as the
  stable tiebreak. A deep row is sorted on what it *prints*, which can be nothing - a run the
  engine matched on snapshot text sinks below one whose URL says what was typed, and among equals
  stays newest-first. That is a change for Runs alone, and a deliberate one: their old order came
  of stuffing the query into every row's keywords, which scored them all alike. Settings is its own
  group rather than more Commands: twelve sections would bury the handful of things the palette can
  actually *do*.
- **A row must clear `MATCH_FLOOR` (0.1) to render.** cmdk keeps every score above zero, so a
  0.0008 match used to render exactly like a 0.99 one. The floor sits just under `commandScore`'s
  `SCORE_CHARACTER_JUMP` (0.17), which is what a match beginning mid-word scores - so "oken" still
  finds "Issue token", and a query reached only by two or more scattered jumps does not.
- **`substringKeywords` are matched literally, not fuzzily.** A URL is the case this exists for:
  to a subsequence scorer any path is character soup, and "theme" scores 0.51 against
  `/the/most/expensive/endpoint`. A request's URL is the one field that uses this. The piece typed
  has to be contiguous, and that is the cost - `v1/charges` finds the row, `v1charges` does not. No
  floor could buy that back: a URL is all separators, so a query scattered across its segments
  reads as a series of *word* jumps, which is what scores the soup so highly to begin with.
- **Requests and collections render at most `PALETTE_GROUP_RENDER_LIMIT` (50) rows each** (#2545).
  They are the two kinds that grow with the workspace, and a row per request was ~5,200 mounted
  `CommandItem`s at 5,000 requests, re-rendered per keystroke. `groupsOf` caps *after* ordering, so
  ranking still sees every row and the best match is inside the cap: a typed exact name is
  promoted to Top result however deep it sat in default order. A capped group closes with a plain
  `N more - keep typing` line (`RankedGroup.hidden`, drawn by `HiddenRowsHint`) that is not a
  `CommandItem`, so the arrows and Enter cannot reach it. A growing window was rejected: the
  palette is a search box, and a longer query is the way to row 51. Tabs, views and commands are
  bounded by the app and the deep kinds by `DEEP_GROUP_LIMIT`, so none of them is capped here;
  Recents, Quick actions and escape rows are unaffected.
- **The announced count is the matched count.** The `aria-live` line reports what the ranking
  kept, hidden rows included, which nothing downstream can drop unannounced.

Four rules govern the deep sources, and each exists because of a way the naive version fails:

- **They contribute nothing to the empty query.** The palette's empty state answers "what was I
  just doing"; ~65 settings entries and every variable key in the app are not that, and a
  server-backed group must not fetch for a palette nobody typed into.
- **Each caps itself at `DEEP_GROUP_LIMIT` rows and offers an escape row** - `Search settings
  for "x"…`, `Search runs for "x"…` - that opens the surface built for browsing the rest, with
  the query carried over (the settings sidebar's `searchQuery`, the History drawer's, whose
  other filters the escape resets so a stale one cannot hide what was just promised). The row
  appears only when there *is* more. Variables has none: no surface browses variables across
  scopes, so it would have nowhere to go.
- **An escape row renders in a group of its own**, below the results. It is not a result: it is
  never scored, never promoted to the top, and never counted. It echoes the query by construction,
  which is exactly what would otherwise score it above every result it is an escape from.
- **A deep row says `preMatched`**, and the ranking takes it at its word rather than forming a
  second opinion from less evidence - decisively so for runs, where the engine matched against
  stored snapshot text that no row prints. It is a property of the row and not of its `kind`: the
  command registry contributes `settings` rows too, one per panel, and those are ordinary shallow
  rows that must clear the floor. Before #1175 the same end was reached by stuffing the keywords -
  with a whole description sentence for settings, and with the query itself for runs, which scored
  every run as an exact match and outranked everything else.

Three things the rows and the frame say (#1176):

- **A row's trailing edge tells you what already runs it.** A command bound to a chord prints that
  chord's key-caps - one `Kbd` per key, through `chordKeys`, from the `Chord` in
  `constants/shortcuts.ts` that the handler itself matches (#938) and never a second spelling of
  one. The registry carries it as `Command.shortcut`, and thirteen commands have one - eight of
  the action rows plus the five drawer-view commands generated alongside them; every other row
  prints nothing, because a plausible key that answers to nothing is worse than no key at all. A
  `Recents` row prints its age there instead, that being the reason it is in the section. A row
  that carries both - a chord-bound command with a recency stamp, which no source produces today -
  prints the chord: the stamp is why the row is in the section, the chord is how the row is run
  (#1260).
  `palette-parity.test.ts` is the check that keeps the two lists honest: every chord in
  `SHORTCUT_GROUPS` either carries a command here or an entry in that file's `NO_COMMAND` map
  giving the reason it does not, so a chord cannot go undiscoverable from both surfaces without
  someone having written down why.
- **The keyboard hints sit outside the band that scrolls.** `CommandFooter`
  (`components/ui/command.tsx`) is a sibling of `CommandList`, not a row in it: the list is the
  one scroller here, so hints placed inside it would scroll away with the results they describe -
  the same reason `DialogFooter` sits outside `DialogBody` in every other dialog (#773). All three
  keys it names are real: the arrows and Enter are cmdk's, Escape is the dialog's.
- **The placeholder does not advertise the chord that opened the palette.** By the time anyone
  reads it the dialog is open, so the one thing the suffix could teach has just been used. The
  title bar's search bar carries ⌘K, where it is still worth knowing.

Three about the frame itself (#1177):

- **Density is a launcher's, not a menu's.** `CommandDialog` no longer overrides row padding or
  icon size at all, so a row is `CommandItem`'s own `px-2 py-1.5` - the 30px single-line row this
  app draws everywhere else - and `PaletteResults` caps its `CommandList` at `min(400px, 60vh)`.
  Measured in Chromium: **eleven rows and two headings on screen at a 768px or taller window,
  nine at 600px**, where the old `py-3` rows in a 300px list showed about six. Six rows plus a
  heading is two sections, which is why the Settings group a query named could sit below the fold
  with nothing on screen saying it existed - the search fix (#1175) put the right row first, and
  this is what makes the rest of the answer visible. The `60vh` half keeps the whole panel inside
  its own `max-h-[85vh]` on a short window once the input and the hints are counted (435px of a
  600px viewport, measured); the autocompletes that share these primitives keep the 300px
  default, their popups being anchored under an input rather than centred. The icon override went
  because it never did what it read as: `[&_[cmdk-item]_svg]:h-5` outranks the `h-3.5` a row
  writes on its own icon, so every palette row drew a 20px icon beside the 14px method rail
  written to match it.
- **The chrome sits on a declared surface, so its dividers can be `border-rule`.** `Command`
  declares `bg-card surface-card` - `--popover` and `--card` are the same three numbers in both
  themes, and only one of them has a surface class to declare, so this is a rename rather than a
  repaint. With it declared, the input's divider, the separators between sections and the footer's
  `border-t` all resolve through the surface instead of the canvas token that is the card's own
  background in dark. Section headings are the `Eyebrow` primitive, wrapped inside the element
  cmdk labels the group by, rather than a third hand-typed copy of its eleven pixels.
  `command.chrome.test.tsx` pins the declaration, the absence of the canvas tokens, and the
  density - `border-rule` classes on their own prove nothing.
- **A query that matched nothing gets an offer, not a dead end.** `ranking.ts` hands the verbs
  back as `quickActions` when a typed query keeps no result, and the list says
  `No matches for “…”. Try one of these:` above them. They are suggestions, not results: the
  announced total stays at zero, which is what "did what I typed narrow anything" asks. cmdk's
  own `CommandEmpty` is unused here for the same reason - it renders only when the list has no
  rows at all, and the verbs are rows.

Two invariants are tested rather than commented. **A variable's value is never indexed**, secret
or not (`secret` is a masking hint, so trusting it would leak every token nobody flagged) - held
in `sources/useVariableItems.test.ts` against the source's output, because the ranking would hide
an indexed value from any DOM assertion. And **an engine that is down hides the Runs
group silently**: typing is idle input, and idle input must never raise a toast.

**Entry points:** the chord, and the `Search` tile on the welcome Launcher. The title bar's
search bar (#529) is the third and becomes the primary one - it flips the same store flag.

## Command Registry (`lib/commands/`)

Every user-facing *action* the app offers by name, declared once. **A new action is declared
here, and its surfaces point at it** - a menu item, a tile or a palette row is a way of reaching
a command, never a second definition of one. Before this, "open settings" existed separately in
the native-menu bridge, the Dock, the settings sidebar and a keydown case, and nothing kept them
in step or could enumerate them.

- **`types.ts`** - `Command` (`id`, `title`, `keywords`, `group`, `icon`, `shortcut?`,
  `available?`, `perform`) and `CommandContext`. A `title` may be a function of the context, which
  is how a contextual command names its target: `Run "payments"`, not `Run collection`. A
  `shortcut` is the `Chord` from `constants/shortcuts.ts` that already runs this command - the
  object the handler matches, so a surface printing it cannot advertise a key nothing answers
  (#938) - and is present only where such a chord genuinely exists.
- **`registry.ts`** - the roster. Actions (new request, import, run collection, send, load test,
  copy for agent - `Copy "<tab>" for agent`, the active tab's `agentReference` from its
  descriptor, absent on a tab that names no entity (#2047) - close tab, save, toggle drawer, toggle context bar, toggle response position - request tabs
  only, toggle theme, open settings) plus one
  command per drawer view - **generated** from `constants/drawer-views.ts`, the same table `ActivityRail`
  reads, filtered to drop Settings (which `open-settings` already covers, tab and all) - plus one
  command per run-export action, **generated** from `runExportActions` (`lib/run-export-formats.ts`),
  the list the Export menu draws (`Save "<tab>" as JSON`, `Copy "<tab>" as Markdown`; available only while a mounted menu fills
  `exportRun`, no chord) - plus one command per settings section, **generated** from `app-panels.ts` and `engine-categories.ts` so
  a section added there appears here without an edit and cannot be named differently.
- **`context.ts`** - `baseCommandContext()`, the React-free snapshot for a caller that is not a
  render (the native-menu bridge). `hooks/useCommandContext.ts` is the full version.
- **`live-surfaces.ts`** - the channel a *mounted feature* contributes a surface through. Four
  named slots: start-load-test and send, contributed by the mounted request builder,
  export-run, contributed by a finished load run's Export menu, and the builder's editor draft,
  read by the context bar's Code section rather than by a command.

Two rules make it work without a dependency-injection tangle:

- **Stores are not in the context.** They are module singletons, so a `perform` calls
  `useTabsStore.getState().openTab(...)` directly. The context carries only what `getState()`
  cannot answer: the active tab, its label and its reference line, the collection that tab
  shows, and the surfaces.
- **A command that needs a surface the caller cannot offer declares itself unavailable** rather
  than throwing when picked. `CommandSurfaces` is optional on the context; the menu bridge omits
  it, so "New request" is simply not among the commands it can run.

### When a surface is a store, and when it is a live contribution

Most of what a `perform` needs is a store, and a store is always the answer when the state
outlives any one mounted view. `CommandSurfaces` covers the rest, and it has two halves:

- **Host-owned** (`newRequest`, `runCollection`, `toggleThemeMode`, `copy`) - dialogs and hooks
  that are React but that *any* rendering caller can mount for itself. The palette does exactly
  that in `useCommandSurfaces`, so offering `surfaces` at all means offering these four.
- **Contributed by a mounted feature** (`startLoadTest`, `sendRequest`, `exportRun`) - state that exists only
  inside one component tree and cannot be lifted without copying it. Starting a load test needs
  the request builder's **live editor draft**, before autosave has run; the palette is a sibling of
  `RequestBuilderProvider`, so a command reading a store would find only the last *saved* request
  and would silently run the old URL after an edit. The builder publishes its own handler through
  `live-surfaces.ts` (`useRegisterLoadTestSurface`, mounted by
  `modules/request-builder/components/LoadTestCommandSurface.tsx`), `useCommandSurfaces` merges
  what is registered, and the command is `available` exactly while that contribution stands - so
  it is absent rather than inert while no builder is on screen, and closing the tab removes it.
  Nothing about the load test moves: the single-active-run policy, the ceilings check and
  `LoadTestConfigDialog` all stay in the builder.

  Send has the identical live-draft problem, so it fills the second slot the same way -
  `useRegisterSendRequestSurface`, mounted by
  `modules/request-builder/components/SendRequestCommandSurface.tsx`. Its contribution is
  conditional where the load test's is not: the builder passes `null` in place of the handler
  whenever `canSendRequest` (`utils/send-gate.ts`) says a send would be refused - a request already
  in flight, this builder's own stream open (where the button reads Stop), or an empty URL - and
  the row disappears with it rather than sitting on screen offering something the Send button
  would refuse.

  A finished load run's export fills the third slot, `exportRun` (#2139), through
  `useRegisterExportRunSurface`, mounted by `modules/history/main/components/RunExportMenu.tsx`.
  What an export sends depends on that menu's comparison toggle, so the handler takes a
  `RunExportAction` and delivers it as the menu's own item would. It is withdrawn while an export
  is in flight. Only the active tab's view is mounted (`renderTabContent` in `Shell.tsx`), so the
  run tab's menu and the dashboard's never hold the slot at once; the identity-checked clear
  covers the hand-over.

  The fourth slot, `editorDraft` (#2638), is a read rather than a command, and is not on
  `CommandSurfaces`. The context bar's Code section has Send's live-draft problem - a snippet of
  the saved row is the old URL after an edit - so the builder publishes a getter over its draft
  and the collection chain it composes Send with (`useRegisterEditorDraftSurface`, mounted by
  `modules/request-builder/components/EditorDraftSurface.tsx`), and the section builds its compose
  body from it with `buildComposeBody`, the builder Send uses. The draft sits in a ref behind the
  getter, so typing writes no store; the slot is republished only when the builder's request id
  changes, and `editorDraftFor(requestId)` answers only for the draft whose own id matches.

The rejected alternative is worth naming, because it is the tempting one: reading the draft out
of the provider from outside it, or recomposing the payload inside the command, would be a second
copy of `buildExecBody` and of the run policy - the "hand-rolled copy of a primitive" defect this
registry exists to remove. The `editorDraft` read does not reopen that door: what it hands out is
the builder's state, and the body is still built by the one shared builder.

The channel is deliberately a **closed union of named slots**, not a registry of arbitrary named
surfaces. Send had the same live-draft problem, and #1243 gave it the second slot rather than a
second channel; #2139 gave the run export the third and #2638 the editor draft the fourth.
`LiveSurfaceSlot` is the keys of one handler table in `live-surfaces.ts` -
`"startLoadTest" | "sendRequest" | "exportRun" | "editorDraft"` - and nothing else, so a fifth
feature with this problem is a decision taken there, not a name a caller can invent by passing a
string.

Consumers: `modules/palette/sources/commandItems.ts` (the Commands and Settings groups) and
`hooks/useMenuActions.ts` (Preferences… → `open-settings`). `lib/commands/registry.test.ts` walks
the roster and asserts every entry says something and that the settings roster still covers both
catalogues; `modules/request-builder/load-test-command-surface.test.tsx` holds the live channel to
handing over the request *as edited*, and to clearing itself on unmount.
`modules/request-builder/send-request-command-surface.test.tsx` holds the same for Send - the
request crossing the channel *as edited*, not as last saved - plus the gate: it asserts the row is
absent while the URL is empty, while a send is already in flight, and while this builder's own
stream is open. `modules/history/main/components/RunExportMenu.test.tsx` holds the export slot:
filled while the menu is mounted, cleared on unmount, withdrawn while an export is in flight, and
delivering with the menu's comparison toggle.
`modules/request-builder/editor-draft-surface.test.tsx` holds the draft slot: the read is the draft
as edited with its chain, one publication across edits, republished on a request switch, refused
for another request, cleared on unmount. `code-section-send-parity.test.tsx` beside it drives Send
and the Code section with one draft and asserts the two compose bodies are equal.

## Tab Breadcrumb (`components/shared/TabBreadcrumb.tsx`)

The one "where am I" line a detail tab draws, and the answer to the builder
being the only surface that had one (#1691). Takes a `label` for the `nav`'s
accessible name and an ordered `crumbs` array of `{ id, label, onSelect? }`.

- **The last crumb is where you are**, and it never gives way: the ancestors get
  `min-w-0`/`truncate` and shrink, the current crumb is `shrink-0`. A deep chain
  gives way; the part you were looking for does not.
- **A crumb navigates only if the caller gave it an `onSelect`.** The current one
  is inert, because you are already there, and a control that does nothing is
  worse than text.
- **Blank labels are dropped, and nothing to show renders nothing** - not an
  empty row, which is the permanent ~30px band `RequestDescription` charged every
  request for before it became the Info tab.

Adopted by the request builder (`useRequestCrumbs` - collection chain, then the
request), `CollectionDetail` (the collection's chain, drawn only when it is
nested: for a root it would repeat the header title underneath itself),
`LoadTestDetail` and the dashboard (`History` + which of the two run states this
is, revealing the drawer with `revealDrawerView` so a crumb never closes the list
it names).

## Toaster (`components/shared/Toaster.tsx`)

Mounted once by `App.tsx`. Renders the queue in `stores/toast-store.ts` through
the shadcn/Radix primitive in `components/ui/toast.tsx`, which owns the dismiss
timer, pausing on hover / focus / window blur, swipe-to-dismiss, and the
`data-state` the exit animation keys off. `F8` moves focus into the stack.

Toasts are the app's **single in-app** channel for reporting the outcome of an
action the user took, including save failures (see `save-store.failSave`). The
one exception leaves the app entirely: a terminal event that lands while Vayu
is not the window in front may also raise an opt-in OS notification
(`services/notify.ts`, issue #1358), and every one of those events still raises
its toast too. Four variants - `info`, `success`, `warning`, `error` - each
carried by an icon and a left rail rather than colour alone; tokens and
durations in `docs/design-system.md` -> Toasts.

## Run Status Pill (`components/shared/RunStatusPill.tsx`)

A run's status as a word and a glyph, tinted by its status family: `Running`
(spinner), `Completed`, `Stopped`, `Failed`. The dashboard header and the history
run tab's header (`HistoryDetail`, #1944) draw it; the history row draws only the
glyph (`RunStatusGlyph`). Welcome's recent runs and the collection context bar's
last-run row take the label and `-text` token alone. All read `RUN_STATUS` in
`components/shared/run-status.ts`, so the label, glyph and `-text` token exist
once per status. The header's `mode` includes `failed` (#1932), set when the
engine reports the run failed, so a failed run no longer reads as Completed.

**`completed` is not a verdict** (#2130). A run that missed a budget, or whose
responses mostly errored, still ends `completed`, and the tick said it went well.
Both components take an optional `outcome` (`passed` | `failed` | `not-judged`,
from `run-outcome.ts`) that refines **only a `completed` run** through
`runStatusDisplay`: `failed` is a ringed exclamation in the error family,
`not-judged` a ringed question mark in the neutral family, each a different shape
from the tick and from `Failed`'s cross; `passed` keeps the tick. The word stays
"Completed" - the verdict is the banner's. The dashboard header takes the
outcome *string* as a prop, not the judgement object: it is memo'd on `Object.is`
and a fresh `{outcome, reason}` per render would defeat it (#1714).

## Run Outcome Banner (`components/shared/RunOutcomeBanner.tsx`)

The line a finished load run opens on: **Passed**, **Failed** or **Not judged**,
then why ("2 of 4 budgets missed: p95, throughput", "All 3 budgets met, but
15.1% errors", "No budgets set. 0.0% errors"). It is a `Callout` - `blocking` for
failed, `info` with the success tick for passed, plain neutral `info` for not
judged - and the live dashboard (between the notice slot and the tab bar) and
`LoadTestDetail` (first in the scrolling body, above the request bar) draw the same component.

The verdict is `run-outcome.ts`, once, and the header glyph and the history row
read it too, so the three cannot disagree. `judgeRun` takes the status, the
report's `thresholdValidation` (which names the missed budgets) *or* a list
row's `verdict` (which does not), and the error rate:

- **failed** - the run's status is `failed`, or a declared budget was missed. A
  budget the run could not measure (`evaluated: false`) is counted by the engine
  as failed, so it lands here and is named like any other.
- **passed** - every budget met **and** no request errored.
- **not-judged** - no budgets were set, or the budgets were met but requests
  errored (a latency ceiling can be met by a run of instant 500s), or the run
  was stopped. Never green: absence of a failure is not a pass.
- **`null`** - still pending or running, or no report: the banner renders
  nothing, because "Not judged" over a report that has not arrived is a claim
  about a run nobody has looked at.

`errorRate` is a percent (0-100) by the one error definition in
`docs/ux-writing.md`. The budgets' short names (`p95`, `throughput`) live in
`threshold-metrics.ts` beside the long labels `ThresholdVerdict` draws, so the
two cannot drift; a metric with no entry keeps its raw key.

## Stop Run Button (`components/shared/StopRunButton.tsx`)

"Stop the run that is happening right now", in the one treatment, for the
places a run can be cancelled: the load dashboard header, the collection-run
tab and the in-progress pane of a load run's History tab. A primitive rather than markup each view repeats, because the treatment is
not a `Button` variant - a destructive *outline* over `ghost`, which no variant
paints, plus the in-flight swap to a spinner and "Stopping…". The label is
`destructive-text`, never the bare `destructive` fill.

The caller owns the request and the failure path: every call site calls
`apiService.stopRun(runId)` and, on failure, raises an **error toast with a Try
again action** rather than a Callout - the run is still generating work, so the
retry is the reason for saying anything. The two History tabs (collection run,
load run in progress) share that through `hooks/useStopRun.ts`, which also
refreshes the run's detail, report and lists; the dashboard header goes through
`useEngine().stopLoadTest`.

## Sample Retention Note (`components/shared/SampleRetentionNote.tsx`)

One sentence, wherever a sampled set is displayed: how many records the run's
bounded stores displaced, and what is on screen. On the `responses` surface
that is drawn uniformly from the whole run rather than its opening - except
when the run's response-sample byte budget was spent, where it says instead
that what is on screen is drawn from the part of the run whose bodies fit. On
the `traces` surface (`report.results`) it says requests with an error are kept
ahead of successful ones and the set is not a uniform sample, because the
report route picks its rows failures first (#2210). Several
surfaces show such a set - the dashboard's Sampled Requests card, the history
Samples tab, and the shared `TestValidationSummary` (itself rendered in both
the dashboard and the history Overview) - so the wording lives here once
instead of being written out per surface and drifting.

Renders nothing when the run displaced nothing, and nothing when the run
reported no counts at all (an older summary): "nothing was dropped" and "we
cannot tell" are both worse as prose than as absence. Built on `Callout`
(`severity="info"`) rather than a hand-rolled muted row.

## Error Summary (`components/shared/ErrorSummary.tsx`)

A run's error card: **Total errors** with its rate (`formatErrorPercent`, two
digits), the **HTTP errors** / **No response** split, then **By error type**
(transport errors, through `errorTypeLabel` so `ssl_error` reads "SSL error")
and **By status code** (`HTTP 500`, or "No response (status 0)"). The history
Overview renders it, and the dashboard shows the same Overview for a finished
run (#2220). It was shared because two hand-built copies had drifted: the
dashboard's own report printed raw type keys and no status-code list, so a run
whose errors were all HTTP 500 showed an empty list under a non-zero total. `ERROR_TYPE_LABELS` has one definition, there.

Props are `errors` (`RunReport["errors"]`), `errorRate` (a percent), and the
`httpErrors` / `noResponse` split, which the caller reads (`DashboardDerived`, or
`errorBreakdown` on the report summary). Renders nothing for zero errors.
`onSelectStatus` and `onSelectErrorType` are optional: given, each By status
code row (or By error type row) is a `listRow` `Button` that reports its code
(or its raw type key, not the label); absent, those rows are plain text.
`hasSamples(target)` (`{ kind: "status", code }` or `{ kind: "errorType", key }`)
lets the caller refuse a row: it is drawn disabled and reads "No sample of this
was kept". The history Overview passes the handlers (#2213), to open the
Samples tab at an example of the row.

## Threshold Verdict (`components/shared/ThresholdVerdict.tsx`)

The run's verdict against the pass/fail budgets it declared
(`RunReport.thresholdValidation`): one row per budget - the limit, what the run
measured, and whether it met it - under a Passed/Failed header. The history
detail's Overview shows it, which is also the dashboard's view of a finished
run (#2220).

It is the **aggregate** counterpart to the Test validation card beside it: a
`pm.test` script sees one response at a time and structurally cannot assert a
p99 or an error rate, so a run where every assertion passed can still have
missed the budget it was run to check.

Renders nothing when the run declared no budgets - which is every run recorded
before they existed - following the same absent-vs-zero rule as
`SampleRetentionNote` and `CapturedDataWarning`: "not judged" is a different
claim from "judged and passed nothing", and only absence can make the first.
The comparator follows the metric (`≥` for the throughput floor, `≤` for the
ceilings), and a metric key this build has no label for renders under its raw
name rather than vanishing from a verdict whose counts still include it.

A single check can itself carry no measurement (issue #1484): a latency
ceiling checked against zero completed requests reports `evaluated: false`,
which the card shows as "no samples" in place of a number rather than the
`0` a run of nothing but errors would otherwise default to and trivially
pass. Such a check counts toward `failed`, and the summary line grows a
"N not measurable" clause. A report from a pre-#1484 engine carries no
`evaluated` key at all and renders exactly as before - absence reads as
measured, the value that engine effectively assumed everywhere.

Each check has a "Copy for agent" icon button (`thresholdReference`, #2047) naming the budget by the engine's
key - `latencyP99Ms`, or `custom.<name>.<stat>` for a custom budget, whose raw key is also the row's label - and
the run, from the optional `runId` prop (both hosts pass `report.metadata.runId`). The limit and the measurement
are never in the line, and without `runId` the buttons are absent.

A run that was **stopped** is judged on what it measured before the stop, and
the card says so (#2194): the optional `stopped` prop adds a line under the
summary, "Run stopped after 3s of a planned 20s. Judged on what was measured up
to that point." The counts and the Passed/Failed badge are the engine's and do
not change. Both hosts pass `stoppedRunOf(report)` (`stopped-run.ts`), which is
`undefined` unless `metadata.status` is `stopped`; it reads the planned span
from `metadata.configuration.duration` (`durationSeconds`) and the elapsed one
from `summary.totalDurationSeconds`, falling back to the start and end stamps.

A check judged against a value the user did not set for this run is tagged
**carried over** (#2195): the optional `carriedBudgets` prop is the list of
`thresholds` keys the run was started with as carried, both hosts pass
`report.metadata.configuration.carriedBudgets`, and a row whose `check.metric`
is in it gets an outline `Badge`. The summary counts the *checks* that are
carried, not the list's length (a key the engine did not judge cannot inflate
it), and the clause sits between the counts and "not measurable": "2 of 3
budgets met (1 carried over), 1 not measurable." The wording is "carried over"
without "from an earlier run" because the SLO-seeded p99 comes from Settings,
not from a run. Absent or empty, the card renders exactly as before.
A run with no declared duration (iterations, ramp, scenarios) drops the "of a
planned" clause, as does one that reached its plan, and a report with no usable
elapsed time says only "Run stopped early."

## Capacity Summary (`components/shared/CapacitySummary.tsx`)

What a `mode: "capacity"` run's adaptive search found (`RunReport.capacity`):
the most virtual users the target held inside its latency budget, the level it
gave out at, and the per-level table both were read off. Shown in the history
detail's Overview, beside `ThresholdVerdict`.

The headline is a **sentence**, not a stat grid, because the mode exists to
answer one question in words - "what can my service take" - and four numbers
side by side make the reader assemble that answer themselves. The table below
is the evidence, for a reader who wants to see the shape of the curve rather
than trust the summary of it.

Three states, not two, and the distinction is the whole point of the component
(same absent-vs-zero discipline as `ThresholdVerdict`, one level deeper):

- **Sustained a level** - the usual reading, with the knee beside it when
  latency is what ended the search.
- **No level held the budget** - the first level already breached. The search
  found no sustainable capacity, which is *not* the claim "this service
  sustains zero".
- **Judged nothing at all** - the run ended before its first level closed
  (`stepDuration` longer than `duration`, or a hand stop seconds in). The
  engine still reports the section, because "the search measured nothing" is
  the finding that says to lengthen the run or shorten the step - but the card
  must say that rather than fall into the second state and claim a measurement
  at a number of virtual users it never reached.

A level the search re-measured after one bad window appears **twice** in the
table, at the same number of virtual users; that repeat is the audit trail doing its job,
so the rows are keyed by index rather than by level. A `stopReason` this build
has no words for renders under its raw key, as `ThresholdVerdict` does with an
unknown metric.

Every latency in the card (headline, knee, budget, table) is `formatLatency`, so
a level at 1234 ms reads `1.23s` like the rest of the app; the same holds for
`TransactionsSummary`. No module declares a `formatMs` or `formatSeconds` of its own
(`lib/no-local-format-ms.test.ts`), and no component calls `toFixed` on a latency, rate
or percentage: `lib/no-hand-built-numbers.test.ts` fails on a `.toFixed(` outside its
short allowlist of axis, byte-size and viewer-phase formatters.

## Contract Coverage (`components/shared/ContractCoverage.tsx`)

Which operations of a collection's bound OpenAPI contract a run exercised, and
which of their declared responses it saw (`RunReport.coverage`, issue #629).
Shown in the history detail's Overview beside `ThresholdVerdict`, and above the
step list in `ScenarioRunView`; the Spec tab carries a one-line version of the
same numbers for the collection's last run (`SpecCoverageLine`).

The other half of "did this run prove anything". `ThresholdVerdict` beside it
says whether the run met its budgets; this says whether it touched the contract
at all, which a run where every assertion passed can still have failed to do.

**Rows are rendered in the order the engine sends them** - uncovered first,
document order within each group. Re-sorting here would be a second opinion
about which operations are the finding, and the two could disagree.

Same absent-vs-zero discipline as `ThresholdVerdict`: an absent `coverage`
renders **nothing**, because "not measured against a contract" is a different
claim from "covered none of it", and it is why a run of an unbound collection
looks exactly as it did before coverage existed.

The uncovered chip is **warning-toned, not destructive**. An operation nobody
called is a gap in the run, not a failure of the system under test, and painting
it destructive would put it in the same vocabulary as a failed budget. The card
also states that its numbers are counted on every send rather than drawn from the
stored sample - it sits among figures that *are* sampled, and a reader has no
other way to tell them apart.

## Sampled Schema Validation (`components/shared/SampledSchemaValidation.tsx`)

Whether the responses a run checked matched the schemas its bound contract
declares (`RunReport.schemaValidation`, issues #682 and #681). Shown directly
under `ContractCoverage`, which it answers the second half of: coverage says what
the run exercised, this says whether what came back honoured it.

**Both run modes render this one block, and its numbers do not mean the same
thing in each.** A load run defers validation to run end over the bounded
reservoir it stored, because it refills concurrency on every completion; a
collection run sends one request at a time and checks every step. So the payload
carries `exact` and the card's scope sentence follows it - "over every response
this run produced" against "over the responses it kept, coverage beside this is
exact". An absent `exact` renders as sampled, because that is what a report
written before the field was, and overclaiming exactness is the worse error.

It renders in every surface that carries a run report: the history detail's
Overview, and a scenario run's own view above the step list. A rollup present in
one and not the other reads as a missing block rather than a scoping decision.

Same absent-vs-zero discipline as `ContractCoverage`: an absent block, or one
that walked no responses, renders **nothing**. A run whose responses were never
checked did not pass a contract.

Reasons for a response that could not be checked come from
`uncheckedReasonText`, the wording the response viewer already shows for a single
response - one copy, so an aggregate row and a user's own response cannot come to
describe the same code differently. The chip is red only for a real schema
failure; a run that checked nothing stays neutral rather than borrowing the
vocabulary of a failed budget.

The file keeps the name it was given for the load-mode block it was written for.

## Test Validation Summary (`components/shared/TestValidationSummary.tsx`)

Whether a load run's own `pm.test` assertions passed (`RunReport.testValidation`,
issue #726): responses tested, assertions passed and failed, the assertion success
rate, and - for the surfaces that have nowhere else to put them - the named failures.

**The labels name the unit** (issue #2144): the engine's `samplesTested` counts
*responses* and `testsPassed` / `testsFailed` count *assertions*, which are different
quantities (a script with three `pm.test` calls over 100 responses makes 300), so the
cells read "Responses tested", "Assertions passed", "Assertions failed" and "Assertion
success rate". The wire keys are unchanged. Every count goes through `formatNumber`.

**The optional `totalRequests` prop** (both callers pass `summary.totalRequests`) adds
one line, "Tested N of M requests. The rest had no response or were not kept." - or
"Tested all M requests." when nothing was left out. The gap is deliberately not worded
as "displaced": a request that errored before a response has nothing to test, so
`M - N` is not `sampling.responseSamplesDropped`. It is omitted when the prop is
undefined or 0, never "of 0". The line states no uniformity; `SampleRetentionNote`
beneath it stays the one place that does, because only it reads
`responseSampleBudgetSpent` and so never claims a uniform sample for a run whose byte
budget was spent.

It is the **assertion** counterpart of `SampledSchemaValidation` above it: that
one judges a response against the contract the run was planned with, this one
judges it against the scripts the run carries. `ThresholdVerdict` is the third
reading of the same run and the aggregate of both, since a script sees one
response at a time and cannot assert a p99.

The history detail's Overview renders it, and the dashboard shows that same
Overview for a finished run (#2220). Until #726 only the dashboard's own report
view did, and the dashboard is mounted **only while a run is being watched**,
so a run reopened from History showed thresholds, status codes and schema verdicts and never said whether its
assertions had run at all: a run that failed 13 of 100 sampled test executions
read exactly like one that asserted nothing, precisely where someone audits
results.

**The named failures are the History half only.** The engine records them on a
*synthetic* result row - `run_manager.cpp` appends one `Result` whose
`trace_data` is `{failures[], totalFailed, totalPassed}`, with `statusCode 0` and
the error "Script validation failures" - which rides in `report.results` beside
the real samples. The dashboard lists each failure inline beside that row, so it
passes the aggregate alone. History cannot: its Samples tab would draw the row as
a status-0 card with no request behind it, so `main/test-validation.ts` lifts the
failures out for the Overview to name and filters the row out of the samples
list. `trace.failures` is what identifies the row - no captured request carries
it, and the status-0 code alone would also match a real connection failure.

Absent-vs-zero, as everywhere in this family: a run that asserted nothing has no
`testValidation` at all and renders **nothing**. A shorter failure list than
`totalFailed` says "Showing N of M" rather than reading as the whole set.

## Element Tally (`components/shared/ElementTally.tsx`)

One element's row - its `kind` and the passed / failed / skipped counts, tallied across
a load run (issue #2144 extracted it from two hand-rolled copies). Both
`RequestElementsSummary` (a single-request run's Elements card) and `ScenarioStepsTab`
(the per-step rows) render it, so a field added to the tally reaches both.

A row with `deferred > 0` - a `script.post` the load path left to the post-run replay -
reads "N requests deferred to a post-run replay of sampled responses - results in Test validation" instead of "0
passed", because its verdicts live in the Test validation card, not in the row. Passed,
failed and skipped still print beside it when non-zero. A `script.pre` that was not
inlined stays `skipped`: it has no replay. `deferred` is absent from a report stored
before the engine wrote it, and such a row keeps the older "N passed / N skipped"
reading; there is no fallback that guesses a script from its zeros.

## Captured Data Warning (`components/shared/CapturedDataWarning.tsx`)

Wherever a run's captured response exchanges are on screen: the run stored those
responses **verbatim**, headers included, so anything credential-shaped the
server sent is stored with them, and it is deleted when the run is
(`maxRunsRetained` is its expiry: only load and collection runs reach this
warning, and those are the runs that cap counts, while design Sends sit under
`maxDesignRunsRetained`).

Capture deliberately does not redact - consistently with design-mode traces,
which already store request headers as sent, and because a redaction guess is
wrong in both directions and gives false confidence when it is wrong the
reassuring way. This notice plus the run's own persisted marker
(`sampling.responseBodiesCaptured`) is the mitigation for that decision, which
makes a silent version of it the same as not having made the decision.

Renders nothing when the run captured nothing, and nothing on a run recorded
before capture existed (the field is absent, not zero) - the same rule
`SampleRetentionNote` follows. Both surfaces that list captured samples render
it: the dashboard's Sampled Requests and the history Samples tab.

## Stored Exchange Warning (`components/shared/StoredExchangeWarning.tsx`)

The design-mode half of the pair above, over a collection run's step list
(issue #731). A scenario run writes one `results` row per step execution holding
the whole exchange - the composed request, the headers as sent, the raw request
line, both bodies - capped only by `maxTraceBodyBytes` and kept until the run is
pruned, so the same "stored verbatim, `maxRunsRetained` is its expiry" sentence
(a collection run is counted by that cap, not by the design-Send one) applies to material the run **sent** as well as material it received. The two
notices are a pair by design: change one and read the other, the drift lesson
`NonLoopbackBadge` was written for.

`dataBound` is why it is more than symmetry. The Data tab and
[Data-Driven Runs](data-driven-runs.md#what-is-stored) promise the file is never
read by the engine and the contract stores no cells - both true, and neither one
a promise about the cells that reach a request, which bind-before-auth (#591)
puts inside the `Authorization` header. When any listed step carries a
`dataRowIndex` the notice says the run's rows are in these steps, so a reader is
not left reconciling two true-sounding claims. `ScenarioRunView` reads the flag
off the steps rather than the report, so a live run discloses it too. Its
optional `dataFileName` prop names the bound file in that sentence (issue
#2051), from the run's snapshot; a run recorded before the field keeps the
unnamed sentence.

Silent when the surface lists no steps - nothing on screen, nothing to disclose.

## Recovery Banner (`components/shared/RecoveryBanner.tsx`)

The one place the user is told the engine restored or replaced their database
(issue #922). A database the engine judges corrupt is **moved aside** (issue
#984) and either the `.bak` backup is restored over it or a new empty database
is created, so the daemon starts instead of crash-looping - and until this
banner the whole record of that was two lines in the engine log, with the app
coming up looking like a fresh install. Only `deleted_corrupt` (an engine older
than #984, or one whose rename failed) means the file is gone.

`HEADLINE` and `DETAIL` are `Record`s over the outcome union, so an outcome the
engine adds without copy here is a type error. Whenever the record carries a
`quarantinedPath`, the banner also names that file, says what undoes the
recovery - quit Vayu and copy it back over the database file, with its `-wal` and
`-shm` when it has them (issue #2420; the engine's account is
[architecture.md](../engine/architecture.md#restoring)) - and gives
`sqlite3 <path> .recover` for a file that really is damaged. The engine judges a
file corrupt only on `SQLITE_CORRUPT` or `SQLITE_NOTADB`; a locked, full or
read-only database is refused at startup instead of quarantined, so no banner
describes one.

It reads `engine-store.recovery`, which `queries/health.ts` writes from the
optional `recovery` node on `GET /health`. Absent means a clean start, which is
also what a genuine first run gives, so the banner renders nothing in the
ordinary case; the engine never reports the node speculatively (see
[db-schema.md](../engine/db-schema.md#the-recovery-marker-issue-922)).

A banner rather than a toast, beside `UpdateBanner` and above it: the fact is
permanent, a user who misses it cannot get it back, and it names a path they may
want to copy. Dismissal is persisted by the record's `at` timestamp
(`stores/recovery-notice-store.ts`) rather than held in component state, because
the engine keeps reporting the record for as long as its marker file stands - a
relaunch against an already-running engine would otherwise re-announce a wipe
the user had already acknowledged. A later recovery carries a later `at` and so
is a different event.

## Non-Loopback Badge (`components/shared/NonLoopbackBadge.tsx`)

"Reachable on `<bind>`", wherever a local service bound past loopback is named. The engine already
refused to bind wide without an explicit `confirmNonLoopback`; this is the standing reminder that the
confirmation was given. One component rather than the same chip twice: the Services drawer and the
inbox tab both render it, and as two copies they had drifted to two different wordings for one fact
(issue #556). `variant="chip"` per the Badge rule - any other variant keeps its own `hover:bg-*`,
which `cn()` does not replace, so the warning fill would turn the accent colour under the pointer.

## Drawer Section (`components/shared/DrawerSection.tsx`)

A group of rows inside a drawer view, and its header: muted small type, an optional scope glyph, an
optional count, an optional collapse chevron and a trailing actions slot. `DrawerPanel` gave the four
views one frame; the groups *inside* a view had none - Services drew muted labels with a plus,
Variables a chevron, an icon, a filled `Badge` count and a plus, and the collection rows wrote the
same fact as inline `(2)` text one click away from that badge (issue #1688).

**One count idiom, and the badge loses**: `DrawerSectionCount` is the muted inline count in
parentheses, exported so a *row* inside a section writes it exactly as its header does - which is how
`CollectionItem` stays in step without gaining a section header (its `DrawerPanel` band already says
"Collections"; a section of the same name inside it would be the double heading this issue removed
from Settings). A string count (`"-"`) is for a number the app does not have yet: a literal `0`
beside "Couldn't load collections" asserts something untrue.

**What a folder row counts** (issue #2251): a root shows every request in its whole subtree
(`countSubtreeRequests`, folders not counted), so a 60-request import into four folders reads
`(60)` as the import preview did; a nested folder shows its direct children, requests and child
folders. `aria-setsize` stays direct children at every depth.

**The header's semantics stay at the call site.** Variables' headers are `role="treeitem"` rows in a
roving-tabindex tree, and the "+" beside one is deliberately outside that row - the tree has no
create key, so the button is the drawer's own tab stop. `rowProps` and `activatorProps` are spread
through, so this component owns the shape and never has to know about the tree.

## Field Error (`components/shared/FieldError.tsx`)

The message under a control that will not take what you typed, and the bottom of the app's three
error levels: **field-level** is `FieldError`, **block-level** is [`Callout`](../design-system.md),
**pane-level** is `ErrorState`. Before issue #1688 the middle of that range was hand-written
`text-destructive-text` paragraphs at three sizes - the import dialog alone carried `text-sm`,
`text-xs` and `text-[11px]` - some with a leading glyph, some announced and most not.

One size (`text-xs`: the sizes were the order the code was written in, not a hierarchy),
`role="alert"` so a message that appears after a keystroke announces itself, an `id` for the
control's `aria-describedby`, an optional leading `icon` for a message that has to be found among
other lines of the same size, and `as="span"` for a parent whose content model is phrasing only (a
`<label>`, another `<span>`) where a `<p>` would be silently reparented out of its row. It renders
nothing for an empty message, so a call site is `<FieldError>{error}</FieldError>` rather than
`{error && …}` - the same swallowing `TabCount` does with a zero. `error-presentation.test.ts`
fails on red prose outside the three primitives; a site where the token is on data rather than on a
message (a failure count, the Dock's "Not saved") is named in that guard's exemption list with what
the red text is instead.

## Allowed Origins Field (`components/shared/AllowedOriginsField.tsx`)

The "Allowed origins" box on the mock server's and the inbox's start forms (issue #2367): a
`Textarea`, one `http(s)://host[:port]` per line, with the helper text "Leave empty to allow any
origin" and a `FieldError` beneath. Shared because both forms ask the same question in the same
words. The parent owns the text and runs `parseAllowedOrigins` (`lib/allowed-origins.ts`), because
it also needs the result to decide whether Start is enabled and what to send; the field only
displays. The parser mirrors the engine's rules (shape, 32 entries, 512 bytes) and sends the
canonical spelling, repeats listed once; the engine stays the authority.

## Number Field (`components/shared/NumberField.tsx`)

A labelled number input with its unit inside the field (`ms`, `%`, `req/s`), an optional hint line,
and an `(optional)` marker on the label - the shape every pass/fail budget field needs. Moved here
from `LoadTestConfigDialog/index.tsx` (issue #1564) once `RunCollectionDialog`'s own Pass/fail
budgets disclosure needed it too: a second copy would not have received this one's fixes. Both
callers pass their own `id` so the two dialogs' budget fields never collide if ever mounted together. An
optional `action` slot draws a control beside the input; `LoadTestConfigDialog` puts each budget's "Copy for
agent" button there (#2047), and the collection runner leaves it empty.

## Shared External Change Callout (`components/shared/ExternalChangeCallout.tsx`)

"Changed elsewhere: `<what>`", with a "Take theirs" action, for a field a dirty
draft is keeping against an external write it disagrees with. Started as
`CollectionDetail/shared.tsx`'s (issue #1437, `useEntityDraft`'s
`externalValue`) and moved here for issue #1436, when the request builder
needed the identical notice for the identical reason: a second copy would have
been the "written but never read" style drift CLAUDE.md warns about, just for
a component instead of a field. `CollectionDetail`'s `InfoTab`/`ElementsTab`/`AuthTab`
and the request builder's `ExternalChangeNotice` (above) are its callers.

## Shared Script Snippets (`components/shared/ScriptSnippets.tsx`)

The insertable templates under a script editor, listed for both script hosts -
the shared `ElementList`'s `script.pre` / `script.post` bespoke form
(`ScriptElementForm`, `components/shared/ElementList/`) used by both the
request builder's Elements tab and the collection detail's (issue #1223).

**It replaced two hand-rolled copies of one idea.** The request panels carried a
14-line `<pre>` of `pm.*` calls plus nine paragraphs of rules, always on; the
collection tab carried a four-card grid of four different calls, behind a
component-state chevron. Neither could be inserted, so a user read a line and
retyped it, and the two lists had drifted from each other and from the runtime.

**The engine's completion table is the source, not a third list here.** Its
snippet entries (`kind` 28) now say which script kind they belong in and which
heading they are listed under (`context`, `group` - see
[`pm-api-compatibility`](pm-api-compatibility.md#editor-autocomplete)), so this
component is a filter and a renderer over `GET /scripting/completions`: the same
templates Monaco offers as you type, made browsable for the author who does not
know what to type yet. `lib/script-snippets.ts` is that pure read, so the
selection rules are tested without a Monaco instance; a heading this build does
not know is listed under its own name rather than dropped, since the engine is
the one that decides what exists.

**Insertion goes through Monaco's snippet controller** (`lib/editor-snippet.ts`),
not a text splice: the templates carry `${1:...}` placeholders, and only the
controller turns those into the tab stops the same template produces when it is
accepted from the completion popup. The host owns the editor instance (captured
through `CodeEditor`'s `onMount`) and passes `onInsert`, so this list never
learns which editor it sits under.

**Collapsed by default, remembered by the host** (`scriptSnippetsCollapsed`,
persisted). The collapsed flag is a controlled prop (`collapsed`,
`onCollapsedChange`), not this component's own store read (issue #1605): the
Elements tab can mount a `script.pre` and a `script.post` row on one screen,
and a single store subscription here would toggle both from one click.
`ScriptElementForm` seeds its own per-row `useState` from the store's
persisted default and writes a toggle back to it, so the *next* row a user
opens still starts where they left one - the reason the GraphQL Variables
pane's collapse lives in that store too, just no longer read directly here.
The whole header is the control, per the composite-row hit-area rule, and the
body is rendered only while it is open. `cmdk` (`Command`) owns the arrow
keys, the highlight, Enter to insert and the filter field, rather than a
third copy of that keyboard handling.

## Shared ElementList (`components/shared/ElementList/`)

The primitive both Elements tabs bind to (issue #1512): an ordered list of a
request's or collection's own elements - extractors, assertions, timers,
controllers and scripts - each a **collapsible card** (issue #1608): a family
icon (one per catalogue category, `element-categories.ts`'s `categoryIcon`),
the element's name or its kind's label, a one-line **summary** of its config
while collapsed (`summarize-element.ts` - `in [200, 201]`, `wait 500 ms`,
`$.token → token (env)`; a kind this module has no template for falls back to
the kind's own description, and one that is genuinely unconfigured to its
first two properties as `key: value`), an enable switch, and a `⋯` menu
(`RowActionsMenu`) for Rename, Move up/down, Duplicate, Copy for agent (when the
host passes `referenceOwner`, #2047) and Delete - the two
Move items carrying "Already first" / "Already last" at the row's ends rather
than being silently off (#1690). Click on
the header toggles the card; a newly added or duplicated element opens
expanded, everything else starts collapsed. Which cards are open is kept per
request or collection id in `tab-selection-store`, so it survives the builder
unmounting and a switch between two open tabs: both hosts bind the list's
optional `openIds` / `onOpenChange` props through `useOpenElementRows`
(`ElementList/useOpenElementRows.ts`), which subscribes by selector. The list
calls `onOpenChange(id, true)` for a row it adds or duplicates and
`onOpenChange(id, false)` for one it removes, so the set never holds an id the
list no longer has. A host with no id (the stored-run copy, an unsaved
request) passes neither prop and keeps component-local state. Alt+Up/Alt+Down on the header's
own two toggle buttons moves the row, mirroring the menu's Move items.
**Rename's autofocus is timed off `RowActionsMenu`'s `onCloseAutoFocus`**, not
a guessed delay: selecting Rename only flags the row's own pending-rename ref,
and the actual state flip - drafting the name, showing the input - runs from
that callback, which Radix itself calls once the closing menu's `FocusScope`
teardown (and the `aria-hidden` it places on the rest of the page while open)
has actually finished. A raw `setTimeout` landed the autofocus before that
cleanup reliably completed, focusing an element still marked `aria-hidden` for
a moment - caught live, not by the jsdom suite, which has no real layout or
`aria-hidden` enforcement to catch it on. The title span itself is capped
(`max-w-[55%]`) alongside `truncate`: a user-typed name has no length limit,
and `truncate` alone never engages without a `max-width` to truncate against -
an uncapped one rendered at its full content width and pushed the switch and
the `⋯` menu out of the row. **The expanded card and `GenericElementForm`'s
own rows run at the app's tightest density** - `space-y-2` and `p-2`/`py-2`
throughout, `size="sm"` inputs, `text-xs` labels -
because this is where a user reads several fields at once, closer to a form
than a settings page read one row at a time. The collapsed header (`h-8`,
matching every other drawer row) is untouched; only what opens beneath it got
denser.
**A missing required field names itself, in place of the summary** (issue
#1635): `missingRequiredKeys` (`lib/elements.ts`) reads the same presence-only
check `addElement`'s fresh `config: {}` can trigger, and the row shows "Needs
`<title>`" with a warning dot instead of `summarizeElement`'s preview -
whether the card is open or collapsed, since a list of collapsed cards is
exactly where a user needs to spot which one is blocking the save without
expanding each in turn. `RequestBuilderProvider`'s `handleSave` and
`ElementsTab`'s `persist` hold the save back for the same reason
`defaultConfigFor` exists above - a request's whole `elements` array 400s on
one incomplete member - and throw `SaveBlockedError` instead of sending a
payload already known to fail; `useSaveManager` reads that type to stay
"pending" rather than backing off a retry against a payload that will not
have changed by the next attempt.

**Delete asks nothing for a blank element** (every configured value empty or
absent) and confirms through `DeleteConfirmDialog` for one with real
configuration. A primitive under `components/shared/` takes no feature-module
context, so both hosts pass their own `elements` array, `onChange` setter and
the catalogue (`useElementKindsQuery`) as props rather than the component
reading either host's context - the same rule `request-builder/types.ts`
states for why `KeyValueEditor` moved out of the request-builder module.

**The default form is generated from the kind's JSON Schema**
(`GenericElementForm.tsx`), the way `SettingsMain.tsx` renders a config entry
by type: string, integer, number, boolean, enum and string-array properties
map to the same row primitives - `NumberSettingRow` / `SelectSettingRow` /
`ToggleRow` - `SettingsPanel.tsx` already uses, plus one level of `object`
nesting for a kind whose config groups two fields (`assert.status.range`'s
`{min, max}`). **Labels come from the schema's own `title` and `description`**
(issue #1607), not the raw property key - `control.throughput`'s `everyN`
reads "Every nth", not `everyN`. A `required` property renders before an
optional one; a property carrying `x-vayu-group: "advanced"` renders instead
under a disclosure, closed on mount unless the element already has a value
for one; `x-vayu-unit` (`"ms"` / `"%"` / `"B"`) becomes the numeric field's
input suffix. A kind the app has never seen is still editable the day the
engine ships it, which is the whole point of the catalogue being
schema-carrying rather than a label list - `extract.json`'s path field is
deliberately generic-form only, proving the point rather than special-casing
it.

**Two short fields standing next to each other share a line** (`grid-cols-2`,
the pairing `AuthFields` and `OAuth2Form` already use). `assert.status`'s
`range` is one idea - "200 to 299" - and saying it as a label, a hint sentence
and an input stacked twice over spent most of an expanded card on two
integers. Only a number or an enum pairs: a JSONPath, a variable name or a
regular expression has no length bound, and a boolean is already horizontal
(`ToggleRow` is label-left/switch-right), so halving its width only crowds its
description. And only **exactly two** adjacent - a run of three is a list, not
a pair (`timer.think`'s `ms` / `minMs` / `maxMs` is a fixed wait beside the two
bounds of a random one, and pairing by position would claim a relationship the
schema never declared). Which two of three belong together is knowledge only
the kind has, and this form knows no kinds: a kind that wants the grouping
declares it as a nested `object`, the way `assert.status` already does, and is
paired here for free. The halves are the settings rows' opt-in `compact`
variant, so each one fills its column instead of stopping at the settings
screen's `max-w-[12rem]` with the rest of the line empty.

**A bespoke override is the exception, in one map** (`elementForms.ts`), never
inline in `ElementList`. There are two: `ScriptElementForm`, below, and
`ModeElementForm` for the five mutually-exclusive-strategy kinds, after it.
Phase 0 ships a bespoke form for every `script.*`
kind - `script.pre` / `script.post` and, since issue #1499, `script.setup` /
`script.teardown` - which render `ScriptElementForm`'s Monaco editor and
insertable snippets instead of the generic form's plain text field, because
"the same editor" is what the Elements tab has to keep for a script. Its lead
sentence is the kind's own catalogue `description` (issue #1608, absorbed
there by #1607) rather than a hard-coded pair of strings, so the text is
authored once and doubles as the card's collapsed-summary fallback. It
deliberately carries none of the old `ScriptPanel`'s variable-reference chips
or inherited/legacy notices - those read `useRequestBuilderContext`, which
this primitive cannot depend on - so inheritance is shown once for the whole
list by `InheritedElementsNotice` instead of once per script row.

**The editor box has a definite pixel height, resizable by a handle below it**
(issue #1605). `ElementRow` is an auto-height card, not a bounded ancestor a
percentage or a `ResizablePanelGroup` could divide, so `CodeEditor`'s default
`height="100%"` used to resolve against nothing and Monaco laid out at zero
height with the typed text hidden. `ScriptElementForm` instead sets the box's
height directly from `layout-store`'s `scriptEditorHeights`, keyed by the
owning element's own `id` (`ElementRow` passes it) - a request or collection
can show a `script.pre` and a `script.post` card at once, and a single shared
value used to mean dragging either one's handle resized both (issue #1643
part 2). A row with no entry of its own starts from the last height set on
*any* row, `scriptEditorHeightDefault`, read once at mount rather than
subscribed to - so a still-mounted row with no entry is never retroactively
resized by a later drag elsewhere. Duplicate (issue #1608) copies the source
row's own entry onto the new id, so a duplicated script starts at its
source's height rather than the default. A handle below the box drags it
between `SCRIPT_EDITOR_MIN_HEIGHT` and `SCRIPT_EDITOR_MAX_HEIGHT`
(`constants/layout.ts`) through `useResizeGesture` (`lib/resize-gesture.ts`,
issue #1738), the rAF-coalesced-write, one-commit-on-release mechanism
`PanelResizeHandle` also uses for the drawer and context bar widths (issue
#1715) - a shared hook rather than two independently-written copies, after
those copies had already drifted (this row's keyboard handling covered only
Arrow keys, and neither handled `pointercancel`). Arrow keys, Page keys,
Home/End and a reset (Enter/Space, to `DEFAULT_SCRIPT_EDITOR_HEIGHT`) all
commit immediately on a discrete press; a held key's repeats are throttled to
one commit per 200 ms (`KEY_COMMIT_INTERVAL_MS`, flushed on keyup and blur;
OS key repeat is slower than a frame, so per-frame coalescing would not help),
so holding a key does not flood `localStorage` with one write per repeat. A `pointercancel`
mid-drag (a touch interruption, an OS overlay) reverts the box to the height
the drag started from and writes nothing.

**Five kinds pick one strategy instead of showing every one at once**
(`ModeElementForm.tsx`, with the table in `element-modes.ts`). `assert.status`
accepts an `in` list **or** a `range`; `timer.think` waits `ms` **or**
`minMs`/`maxMs` **or** a `gaussian`; `assert.jsonpath` checks `exists` **or**
`expected` **or** `regex`; `control.throughput` limits by `everyN` **or**
`percent`; `metric.record`'s `source` reads exactly one of its six keys. The
engine resolves each by an if/else-if chain or a fixed-priority loop and never
combines two - but JSON Schema declares them as independent optional siblings,
so the generic form rendered every alternative's fields at once, with nothing
saying which one would actually run. That is not only clutter: an element that
once had a `range` and was then given an `in` kept the `range` invisibly, and
the engine's own priority could still prefer the hidden one over the fields on
screen. `metric.record`'s schema comment says why the fix cannot be a
schema-level `oneOf` (valijson reports "matched N schemas" without naming one),
so it lives entirely here. **The mode on screen is derived from `config`, by
the engine's own priority order** - transcribed into `detectionOrder`, one per
kind, each naming the C++ function it came from - so the card cannot claim one
strategy while the engine runs another; a blank element starts on the kind's
stated default (`assert.status` on `in`, `timer.think` on `ms`, which is the
engine's *fallback* rather than its first check, hence the two orders being
separate). **Switching modes clears the other strategies' keys**, since a
leftover is both unreachable in the UI and, with `additionalProperties: false`
on all five schemas, a save failure. The chosen mode's own value is kept, not
reset - switching *to* it is what makes that data visible and editable. The
picker is the `ToggleGroup` segmented control up to three modes and a compact
`SelectSettingRow` past that (`metric.record`'s six sources), the split
`SettingControls.tsx` already draws between a few options a user browses and a
set that reads as a list. Everything below the picker is still
`GenericElementForm`, over a subset of the same schema: titles, hints, units,
the advanced disclosure and the two-fields-per-line pairing arrive unchanged,
so a mode's fields are literally the same rows as every other card's. A mode
whose key is a boolean *marker* (`exists`, `latency`, `status`, `size`) renders
no field at all - the engine reads the key's presence and ignores its value, so
a toggle would offer an "off" that turns nothing off; choosing the mode writes
`true`. Only the mode *labels* are app-side copy, because a strategy is a
grouping the schema does not name (`minMs` + `maxMs` are one mode with two
titles); every field label still comes from the catalogue.

**The Add control is a searchable picker (issue #1604), not a plain dropdown.**
A `Popover` holds a `Command` (`ElementList/element-categories.ts`'s display
map), so a user can type "regex" instead of reading twenty rows for "Extract
with a regular expression" - each row shows the kind's description via
`TruncatedText`, not only on hover. Groups render in family order (Extract,
Assert, Timer, Controller, Script, Metric); a category the map does not know
still renders, last, under its own raw name, so a kind the engine adds needs
no change here. `control.transaction` displays under "Controller" although its
engine-side category stays `"transaction"` - that string is a load-bearing
lookup key for `TransactionHistograms` and the `includeTimers` fold, so the
picker folds it for display rather than the registration changing what it
means. `inherit.disable` is excluded from the picker entirely, since a user
never adds one by hand - it is written by the inheritance notice's Disable
toggle. The last five kinds added surface under a "Recently used" group,
persisted in `layout-store`'s `recentElementKinds`.

**A new request or collection sends no `elements` at all** (issue #1609):
creation used to seed an empty, enabled `script.pre`/`script.post` pair
(`lib/elements.ts`'s retired `defaultScriptElements`) so the two script tabs
this feature replaced still had a visible slot on a fresh entity. That made
`InheritedElementsNotice` claim "2 elements will run before your own" about a
collection whose two elements did nothing, and gave the engine an empty
script to compose, run and report as a real outcome. A blank `script.*`
element (`isBlankScriptElement`, `lib/elements.ts`) is now inert everywhere it
is read - `scriptTextFor`, the Elements tab's badge count, and
`InheritedElementsNotice`'s count and list - the app-side half of a rule the
engine pipeline enforces the same way (`docs/engine/elements.md`), so the
seeding lost its reason to exist. **A fresh entity's Elements tab shows a
sentence plus quick-add chips instead of a bare `emptyLabel` string**
(issue #1608): `ElementList` itself computes them from whichever kinds it
finds in the `kinds` prop it was already handed - Extract from JSON, Assert
status code, Pre-request script and Post-request script always (#2129), Setup script only when the
collection tab's own `kinds` (which, unlike the request tab's, includes the
`collectionOnly` kinds) offers `script.setup`. A click adds that kind,
expanded, the same as the picker.

**A newly added element seeds `config` from `defaultConfigFor`, not a bare
`{}`** - found live: the engine validates a request's whole `elements` array
on every save, and a script kind's schema requires the `script` key *present*
(`required: ["script"]`, checked engine-side by `valijson`, key presence only,
no `minLength`); `config: {}` alone omits it, so quick-adding "Pre-request
script" and then touching anything else on the request 400s the *entire* save
with "Missing required property 'script'", not only that element's own. A
script kind seeds `{ script: "" }` instead - a real, valid value (the engine
already treats a blank script as a no-op, `is_blank_script_element`), not a
placeholder. Every other kind still seeds `{}`: several of them have their own
required, non-blankable string fields (`extract.json`'s `variable`,
`control.transaction`'s `name`, both `minLength: 1`) that an empty string
would not satisfy either, and a kind-specific fake placeholder would be worse
than the failure it dodges - tracked as a follow-up rather than guessed at
here (issue #1635).

## Shared Response Viewer (`components/shared/response-viewer/`)

Response-rendering primitives reused outside the request builder (e.g. history detail):

- `UnifiedResponseViewer.tsx` - top-level response view for stored runs. Its **Events** tab appears only when the caller passes an `events` node - a load run's captured stream (issue #657) - because almost every sampled row is not a stream, and a permanent tab reading "not an event stream" would be noise on all of them
- `ResponseBody.tsx` - body rendering (JSON/text/HTML/XML; SVG is XML). A body with no text view - `rawBytes` with `isText: false`, the decoded base64 the engine sends for a body that is not UTF-8 (issue #2458) - skips the editor under the same toolbar: an image is drawn from its bytes through a Blob object URL revoked on unmount, and a PDF or other bytes are named with their size. Whether there is any text comes from the funnel's `rawBytes.isText`, not from a sniff of its own. A decoding that replaced bytes or met an unknown charset gets a warning `Callout` over the text. Past `LARGE_BODY_BYTES` (2 MB, `utils.ts`) it drops to a **large-body mode**: no `formatBody`, no syntax highlighting, no Pretty/Raw/Preview toggle, and only the first 2 MB of the raw body in the editor, under an info `Callout` saying so. Everything this component does to a body it does synchronously during render - `formatBody`'s indent pass (a copy larger than its input), then Monaco tokenising the result - so a multi-megabyte response froze the window between Send and the pane painting. `formatBody` indents JSON with `lib/json-format.ts`, which copies the received text token by token without parsing a value, so member order, duplicate keys and integers past 2^53 show as the server sent them (issue #2459); the funnels hand it the received text, and Copy, Download, Save as example and the Raw tab take that same text unchanged rather than the indented copy. The Download half of the notice is worded against the `actions` slot, which the history viewer does not pass. Separate from the engine's `bodyCapped` notice (see the request builder's `ResponseViewer/`): this one is the *pane* declining to format what it was given, that one is the engine never having read more - both can be on screen at once
- `preview-document.ts` - the document the HTML **Preview** frame renders. The frame is `sandbox=""`, never `allow-same-origin`: the markup is the server's, and with `allow-scripts` beside it the frame would run that script as the renderer, `window.parent.electronAPI` included. So the preview runs no script at all, submits no form, opens no popup and cannot navigate the window. `buildPreviewDocument` puts a Content-Security-Policy in front of the server's markup that loads nothing from the network (images, fonts and media from `data:` only, stylesheets inline only), since a srcdoc document resolves relative URLs against the renderer's base URL and would otherwise send GETs wherever the body pointed, the engine's loopback port included; a page that leans on a CDN previews unstyled. Links are inert through `<base target="_top">`, which the sandbox refuses. The injected policy is the preview's only one (#1780): it lives in the document, where `sandbox=""` enforces it without `allow-same-origin`, and the frame carries no `csp` attribute. `preview-sandbox.test.tsx` holds the attribute and scans every `<iframe>` under `src/` for a sandbox without `allow-same-origin`
- `ResponseEvents.tsx` - the Events timeline (issue #574). It lived under `request-builder/components/ResponseViewer/` until a second surface needed it: a load run's sampled stream, whose events the engine parses back out of the stored body and serves on `GET /runs/:id/samples`. Three sources now feed one list - the live relay, a restored design trace, and a captured load sample - and the truncation disclosures (`eventsTruncated`, per-event `dataTruncated`) are stated once for all three. The rows are memoized and rendered through `useGrowingWindow`, since a stream runs to 100,000 events by default (issue #1158); a source whose list grows in place passes `listKey` so the window resets on a new stream rather than on every batch, and the two that arrive whole want the default
- `CapturedResponseNotice.tsx` - what a captured load-run response is *not*: truncated at `maxSampleBodyBytes`, dropped once the run's `maxSampleBytes` budget was spent, or binary and therefore stored by size and type. All three are invisible in the bytes - a truncated body looks malformed, a dropped one looks empty - so the difference is stated rather than left to be inferred
- `HeadersViewer.tsx` - the headers family, three variants in one file: the collapsible table, `CompactHeadersViewer` (same content on a sunken slab, for panes with no room for a table), and `ResponseHeadersPanel` (the Headers *tab* - request collapsed above response open, with the empty state `HeadersViewer` alone cannot give). The panel's request section lists the request as it was sent (issue #2464), taken from the engine's recorded raw request when it has one: `wire-headers.ts` reads the header block of `rawRequest` into `ResponseState.wireRequestHeaders`, every line in wire order, the transport's own (`Host`, `Accept`, `Content-Length`, the jar's `Cookie`) beside the author's and a repeated name as separate rows, so `HeadersViewer` takes a list of `[name, value]` lines as well as a map. It is derived once, in both response funnels, so a live send and a restored run list the same lines. With no recorded frame (a restored row, whose Raw tab fabricates one, and a failed send) the section lists `ResponseState.requestHeaderLines` (issue #2466): the request's own lines as sent, in order, a repeated name a row each in the spelling typed, which both funnels set through `sentHeaderLines` (`/execute`'s `requestHeaderLines`, the trace's `request.sentHeaderLines`; an empty list is an absent one). Only an answer that predates both shows the folded `requestHeaders`. The compact viewers keep reading `requestHeaders`. The response side renders the header lines as received (`headerLines`, issue #2460): a repeated name is a row each, in the server's case, and the Headers tab count counts them; with no lines the table is built from the folded map (`resolveHeaderLines`). A load-run sample and an inbox capture keep the map alone.
- `StatusCodeBadge.tsx` - the status chip
- `TestsChip.tsx` - what a step's assertions came to, as one line (issue #724). Two states and an absent third: a step that asserted nothing is given no tally and renders no chip, because `0 passed` reads as a result where the truth is that nothing was claimed. Here rather than in the step list because it summarises a *response*, and because the live half (the `step` event's two numbers) and the restored half (the stored list, tallied) must not word it two ways
- `ResponseStatusBar.tsx` - status chip + elapsed time + payload size. Beside the elapsed time, when the response carries `timing.engineMs`, a muted "in Vayu" figure: Vayu's own cost for the send (#2132), with `ENGINE_COST_TIP` (`utils.ts`) as its hover and the Timing tab's tip. Drawn only for a finite figure of zero or more; a stream, an auth failure and an older stored row show none
- `ResponseActions.tsx` - the copy/download pair. Given `rawBytes`, Download writes those exact bytes as a Blob under the response's Content-Type (`downloadBlob`, `lib/download-text-file.ts`) with an extension from that type, and Copy is disabled behind a `DisabledHint` for a body with no text
- `tab-trigger.ts` - `RESPONSE_TAB_TRIGGER`, the underline-on-active class
- `phase-tips.ts` - `PHASE_TIPS`, the five per-phase timing tooltips (DNS -> Connect -> TLS -> TTFB -> Download), shared so every renderer of those numbers reads one string
- `timing-phases.ts` - `TIMING_PHASES`, the same five phases as one descriptor list (label, hue, tooltip, and the trace/average field each reads), plus the `phasesFromTrace` / `phasesFromAverages` selectors
- `TimingPhaseTiles.tsx` - the dense tile grid (one labelled box per phase), rendered inside the sampled-exchange shell
- `SampledExchange.tsx` - the sampled-exchange shell: summary row, expansion, error block and timing tiles

> **One shell for a sample row.** The dashboard's live sample list and the
> history detail's stored one showed the same thing - a sampled HTTP exchange
> you can expand - and were two components (the dashboard's went with #2220,
> when it began rendering History's report). #60 gave them the same per-concern
> primitives, which moved the drift up into the shells rather than removing it:
> each still owned its summary row, its expansion chrome and its section order,
> so a spacing or empty-state fix to one did not reach the other. By the time
> they were merged the rows differed in almost everything that is not data - one
> chevron and one hand-drawn CSS triangle, two different icon sets, and a
> slow-request state on only one side.
>
> `SampledExchange` is **presentational over already-shaped data**: a status
> code, a latency, a pre-resolved phase list. Expansion stays the parent's
> state; the history detail holds a single open row. What the caller adds
> arrives as slots (`details` before the timing tiles, `children` after, and
> `actions` beside the summary, outside its button), not as
> boolean flags; the caller keeps its own chrome and its own timestamp
> formatting, because a stored row dating a run wants the day where a row
> placing a sample inside a seconds-old run would want milliseconds.
>
> Its icon reads **error** for a transport `error` or any status outside
> 200-399 (`isErrorStatus` in `constants/http-status.ts`, the renderer's copy of
> the engine's `is_success_status`, #2124), so a 404 or a 500 does not wear the
> success tick; a caller that knows better passes `state`.
>
> Guarded by `sampled-exchange-adoption.test.tsx` (the shell is replaced with a
> sentinel, so a view that hand-rolls a row fails) and
> `SampledExchange.test.tsx` (the shell's own behaviour).

> **One list, four renderers.** The five network phases are drawn by the
> request-builder's `ResponseTimingTab` (timeline + legend), the history
> Performance tab's `PhaseAveragesCard`, the dashboard's
> `charts/TimingWaterfall`, and the history `SampleRequestCard`. Each used to
> declare its own copy of the list, so adding a phase meant finding every
> renderer and nothing pointed you at the others. Two had already drifted: the waterfall
> painted TTFB with `--primary` - an accent-tracking token the design system
> forbids for a chart series, and the very bug `ResponseTimingTab`'s header
> comment describes fixing in its own copy - and carried private tooltip strings
> that `phase-tips.ts` existed to replace.
>
> Add a phase to `TIMING_PHASES` and every renderer picks it up.
> `timing-phases.test.tsx` guards that by mocking in a sixth phase and asking
> each renderer to show it, so a call site that goes back to a local array fails.

> **Two shells, shared parts.** The request builder has its own richer
> `components/ResponseViewer/` (console output, test results, cookies, timing,
> raw request/response, client-error view) fed from live context;
> `UnifiedResponseViewer` shows two tabs from a stored run - three when
> the sample streamed - and adds a compact mode. They are **not** merged, and should not be: seven tabs against three,
> live context against props, and three different empty/loading/error states
> would become a component driven by flags.
>
> What *was* duplicated is extracted above. Before this, the status bar existed
> twice class-for-class, the copy/download pair twice (already drifted three
> ways), the Headers tab twice, and the tab-trigger string ten times - which is
> why the same invisible-divider fix had to be applied to both, and why
> `StatusCodeBadge`'s `status === 0` branch was once lost from one copy and
> rendered a literal `0`.
>
> Adding a genuinely shared piece: put it here and consume it from both. Adding
> something only one shell needs: leave it in that shell.

## Shared Auth Fields (`components/shared/AuthFields/`)

The one editor for a request's or collection's **concrete** auth, consumed by the
request builder's `AuthPanel` and the collection `AuthTab`. Both hosts hold the
domain `RequestAuth` shape, so the component reads `mode` and `in` directly -
there is no editor-local vocabulary and nothing to translate at the boundary.

- `AuthFields.tsx` - the None / Bearer / Basic / API Key field groups, and
  oauth2 delegated to [`OAuth2Form`](#shared-oauth-20-form-componentssharedoauth2form). Takes an **injected
  `TextInput`** (the same contract `OAuth2Form` defines) so the builder supplies
  a variable-aware token editor while the collection editor takes the default
  plain input, which accents `{{var}}`. `noAuthDescription` is host-supplied: a
  request sends nothing, a collection hands nothing down, and those are different
  statements under one empty state. An API key sent in a **header** carries a
  one-sentence note that a redirect takes the key to whichever host it leads to
  and that turning off Follow redirects on the request prevents it (issue
  #2476): libcurl drops only `Authorization` and `Cookie` across hosts. A query
  key and the `Authorization` modes do not get it, and
  `AuthFields.test.tsx` holds all three branches.
- `types.ts` - `AuthFieldsProps`, `AuthTextInput`, `EditableAuth`.

What stays with each host: the mode picker (only the request offers `inherit`),
the collection's per-mode inheritance hints, and the "stored but not editable"
warning for `digest`/`aws`/`ntlm`/`hawk`/`oauth1`/`edgegrid`/`jwt` - modes the engine cannot resolve, which both
editors surface rather than collapse to "none". The warning says Vayu does not send
the type and the request goes out without auth; the context bar's Auth section and the
inherit banner say the same through `isEngineExecutableAuthMode` (`constants/auth-modes.ts`)
instead of "Sending <mode>". `AuthFields` renders nothing for
them and carries their config through untouched.

Mode names and the editable list live in `constants/auth-modes.ts`
(`AUTH_MODE_LABELS`, `EDITABLE_AUTH_MODES`), which every auth surface reads -
including `AuthInheritBanner`. Four places used to name the modes independently
and had drifted; `auth-modes.test.ts` and `AuthFields/auth-editor-parity.test.tsx`
hold that line, the latter by rendering both hosts and comparing what they show.

## Shared OAuth 2.0 Form (`components/shared/OAuth2Form/`)

The reusable OAuth 2.0 auth editor, consumed by the request builder's `AuthPanel` (and structured to be host-agnostic). A barreled module like `response-viewer/` (its `index.ts` exports the public surface):

- `OAuth2Form.tsx` - grant-type select (Client Credentials / Password / Authorization Code + PKCE), per-grant fields, an advanced section (placement, prefix, audience/resource, credentials id, and the extra request parameter tables), and the token status row. Takes an **injected `TextInput`** so the host supplies a variable-aware input; secret fields render the masked `SecretInput` instead.
- `TokenStatusRow.tsx` - cached-token status (masked token + expiry countdown, with a reveal toggle) and Get/Refresh/Clear actions. Drives interactive sign-in via `services/oauth/authorize.ts` for the Authorization Code grant. The row always renders: an incomplete config **disables** the token action and names the fields still missing (by their on-screen labels) rather than hiding the affordance. Presence only - the engine owns URL validity, and its 400 surfaces as a toast **relabelled** through `constants/oauth2-fields.ts`, so `accessTokenUrl must be an http(s) URL` reads as *Access Token URL*. The same registry supplies the form's labels for those fields, and the `AUTH_FAILED` toasts in the request builder and `DesignRunView` relabel the identical engine string. Internal to the module.
- `ParamRowsEditor.tsx` - one of the config's extra request parameter lists (`authorizationParams` for the authorization code grant, `tokenParams`, `refreshParams`; issue #2536) as a [`KeyValueEditor`](#shared-keyvalue-editor-componentssharedkeyvalueeditor). It takes the host's `variables` (forwarded through `AuthFields`) so a row has the `{{` autocomplete and the resolved peek. The token and refresh mounts pass `sendAs`, which gives every row a "Send in" select (Body, URL, Header; issue #2571) through `KeyValueEditor`'s `rowExtra` slot; the authorization mount does not, since every row of that list rides the sign-in URL's query. Body is an absent `sendAs`, so choosing it removes the member and a config that never used the select is unchanged, and an imported `url` or `header` row shows its place and keeps it through every other edit. The trailing spare row has no select (it is dropped while blank, so a choice made there would be lost), and an unticked row's select is off like its fields. The select is named per row (`Send audience in`), and its renderer is a `useCallback` because the row it reaches is `memo`-wrapped. An emptied list is removed from the config, not stored as `[]`. `resolvedConfig` resolves every row's key and value under a per-row `stableConfigField` entry, so the status row's cache key (which reads these rows) and a Get Token see the same text.
- `types.ts` - `OAuth2FormProps`, `OAuth2TextInput`.

Config resolution (`{{variables}}`), the token cache key (`services/oauth/cache-key.ts`, byte-identical to the engine), and the token queries (`queries/oauth.ts`) sit behind it.

## Shared Key/Value Editor (`components/shared/KeyValueEditor/`)

`index`, `KeyValueRow`, `FilePartCell`, `grid.ts`, `key-value.ts` - the app's key/value
table (params, headers, form fields, and a webhook inbox's canned reply
headers).

**Resolution is an input, not an ambient dependency:** the optional `variables`
prop carries the [`VariableSupport`](#variable-scope-as-a-prop-variablesupport)
scope, and with it omitted the table resolves nothing, shows no `ResolvedPeek`
and offers no `{{` autocomplete - the correct reading of a surface with no
variables. That is what lets it mount outside `RequestBuilderProvider`; before
it, `KeyValueRow` called the context hook in its body and that hook *throws*
with no provider, so every other surface hand-rolled its own rows (issue #564).

**The Σ peek hides a secret variable's value** (#1810). It prints the row's
resolved text, so `token={{secretVar}}` would show the secret on Params, Headers
and both Body tables. `ResolvedPeek` applies `variables.maskSecrets` to the text
it draws and to nothing else: the cached resolution (`stableRowField`) and
`hasVariables` keep the real value, and the trigger's `aria-label` is built from
the row's unresolved key, so it never carried one. A scope without `maskSecrets`
(a surface with no variables) shows the text as is. `KeyValuePeek.secrets.test.tsx`
renders each table through its real panel.

**`fieldContext` says what kind of field the rows are** (issue #2639): `header`
for the Headers tab, `plain` (the default) for every other table, as the
engine's bind treats them. Each row resolves its key and value through
`variables.resolveField` with it, so with a data row picked a cell bound into a
header that carries a line break previews as its token, and the peek opens with
the send's refusal under the text (`TooltipValue`'s hint line). A refusal names
the token, never the cell. The context is fixed into one resolver per
`resolveField` and context (`resolverFor`), because `stableRowField` checks its
resolver by identity. `bound-row-escaping.test.tsx` renders the Headers and Body
panels with the real resolver holding a row.

`allowFiles` (form-data only) turns each row into a text/file switch and stays
on this table rather than the caller, since only the request builder has a wire
format that can carry a file; `FilePartCell` is the value cell of a file part -
it picks a file, shows the path, and marks one the engine would refuse or has
not answered for yet (`unresolved` not `false`; a pick sets `false` until the
next read, and a part that names no file is not marked: there is no path to
doubt). The picking itself - the hidden input, and a `File` turned into the
path the preload reports - is `components/shared/file-pick.ts`, shared with the
binary body editor. `lib/file-path.ts` holds the basename rule it shares with the
importers, and the parent-folder and under-a-folder rules the binary editor and
the import preview use.

The **variables table is deliberately not a consumer.** `modules/variables/main/VariableTableEditor.tsx` keeps its own rows for the reasons recorded in [Variables](#variables-modulesvariables); the parity it must hold with this table anyway is guarded by `key-value-parity.test.tsx`, not by hand.

The per-row gates are per field (`canEdit(item, "key" | "value")`), and the enable box answers to `canDisable` alone, not to the key's lock: the Params tab's path-variable table (issue #1764) locks the key, which the URL owns, and still lets the user switch the row off.

**`KeyValueRow` is `memo`-wrapped, so the table's callback identities are what decide which rows repaint on a keystroke** (issue #1716). `handleRemove`, `handleUpdate`, `handlePickFile`, `handleToggleKind` and `handleReplace` in `index.tsx` do not list `items` in their `useCallback` deps - `onChange` rewrites `items` to a fresh array on every keystroke, so a dep on `items` would give all five callbacks a new identity every keystroke and fail every row's shallow prop compare, however many rows a single edit actually touched. Each callback instead reads the current list through a ref (`itemsRef`, kept in step by a `useEffect`), so their deps are `[onChange, canEdit]`/`[onChange, canRemove]`/`[onChange, canEdit, canDisable]` only - stable as long as the caller's `canEdit`/`canRemove`/`canDisable` are - and only the row whose own `item` changed re-renders. The `canEdit`/`canRemove`/`canDisable` defaults are module constants for the same reason: an inline arrow in the parameter list is a fresh function every render, which would defeat the ref-backed callbacks exactly as a dep on `items` did for any caller that leaves them unset. **The caller's `onChange` is part of the same rule**: it is also a dep, and every keystroke rewrites the caller's own state. `ParamsPanel`'s two handlers therefore read `request.params`, `request.url` and `request.disableUrlEncoding` through a ref (`latest`) and list only `updateField`; `ParamsPanel.render-count.test.tsx` pins it.

`grid.ts` holds the table's **column track** (`KEY_VALUE_GRID` and its `_WITH_FILES` / `_WITH_EXTRA` variants) so the header band, `KeyValueRow` and the request builder's read-only "Added by Vayu" rows in `HeadersPanel` cannot drift apart (#2071); it is a module of its own because the editor imports the row.

**`rowExtra` is an opt-in column for a caller's own per-row control** (issue #2571): `{ header, render(item, { replaceItem, disabled }) }`. A table that passes none keeps the track, header band and cells it had (`row-extra.test.tsx` pins it), so Params, Headers, form-data, urlencoded and the inbox are unchanged. With it, `keyValueGrid(allowFiles, true)` adds a 7rem column after the value on the header band and every row. The control writes by handing back the whole row (`replaceItem`), because the table's own `handleUpdate` knows only the fields of a `KeyValueItem`; `handleReplace` keeps the row's `id` and answers to `canEdit(item, "value")` like a file pick. The trailing spare row gets an empty cell, and `disabled` is true for a switched-off row, a read-only table or a locked value. `render` reaches the `memo`-wrapped `KeyValueRow`, so the caller keeps its identity stable (#1716). Its one user is [`ParamRowsEditor`](#shared-oauth-20-form-componentssharedoauth2form).

`key-value.ts` is the table's **row model**: `toKeyValueItems` /
`toKeyValueEntries` convert between the domain `FormFieldEntry[]` and the
UI-layer `KeyValueItem[]` (which adds the ephemeral `id` React keys need), and
`withTrailingBlank` is the one definition of the spare row at the bottom. It
moved here from `modules/request-builder/utils/` with the table (issue #567),
because a second mount site needs the same conversion and a primitive cannot
take it from a feature module. What stayed in the request builder is what no
table asks for: `toHeaderRows` (execution-shaped) and the managed system
headers. `KeyValueItem` and `KeyValueEditorProps` live in `types/ui.ts` for the
same reason - there is deliberately **no re-export shim** in
`modules/request-builder/types.ts`, so each name has one import path.

## Shared Variable Input (`components/shared/VariableInput/`)

`index`, `EditableVariable`, `RuntimeToken` - input with
`{{variable}}` highlighting + autocomplete. Takes the same optional `variables`
scope; without one it is a plain text field, since a token would paint a name
"not defined" and open an editor with nowhere to write. Its height is a `size`
prop, the same `"default" | "sm" | "xs"` as [`Input`](#input) and read from the
same `input-size.ts`, put on the wrapper that owns the box; a caller states a
size, never a height class (the key-value rows and the binary body's fields are
`size="sm"`). The URL bar's `UrlInput` is the exception the sweep names:
UrlInput is the one text field that is a band component, not a control: it
fills the min-h-band-md URL bar, so its h-full is correct.

**A token has four states, decided in the order `resolveTemplate` decides
them** - reserved namespaces first, then the scopes, then the generator table.
The overlay paints that decision rather than making it; `classifyVariableToken`
makes it, for every surface (see below):

| Token | Painted by | Looks like |
|-------|-----------|------------|
| `{{data.email}}` - the reserved `data.*` namespace (issue #402) | `RuntimeToken`, or a decoration in an editor | muted or amber, depending on the declared contract - see below |
| `{{$vu}}`, `{{$iteration}}` - the reserved identity namespace (issues #994, #1101) | `RuntimeToken`, or a decoration in an editor | muted, "not generated here", no popover |
| `{{merchantId}}` - a stored variable, or a name nothing defines | `EditableVariable`, or a decoration in an editor | accent when it resolves, **red** when it does not; hover opens the popover inert (issue #1220 hover redesign), a click places a caret, and Enter/Space - or ⇧⌘D in an editor - opens it focused |
| `{{$guid}}` - a generator | `RuntimeToken`, or a decoration in an editor | muted, "generated per use", no popover |

The two reserved rows sit above the scopes for the same reason and the generator
row below them for the opposite one: a scope that defines `$guid` wins and takes
the editable token, while a variable named `data.email` or `$vu` answers for
neither the column nor the identity, so it must not paint as though it had. The
identity names are matched exactly, so `{{$vus}}` is an ordinary unknown `$name`
and keeps the red paint that is how a typo is spotted (issue #186).

**The same four states now paint inside the Monaco body and GraphQL editors
too** (issue #1220), as decorations rather than DOM tokens - there is no
`<input>` behind that text to overlay. For a run-time token, hovering still
opens the app's own read-only card (`TokenHoverCard`) over the token's screen
rectangle - not Monaco's own hover widget, which is what answered until issue
#1320. For an editable token, hovering (after the same debounce) opens the
same shared `VariablePopover` instead, over that same rectangle, but inert:
nothing is focused, so resting the pointer never steals the caret from
wherever the reader is actually typing (issue #1220 hover redesign). A click on
an editable token now only places a caret in it - Monaco's own native
placement, once nothing intercepts the click - and `EDIT_VARIABLE_CHORD` opens
the popover focused, which is also the only role left for a keyboard user with
no hover state. The popover stays open through a short grace period if the
pointer moves from the token onto the popover's own content, and closing it
only calls `editor.focus()` back if it actually took focus at some point - a
hover the reader merely swept past must not steal focus from another field
when it closes. The decision of *what a token is* is shared:
`classifyVariableToken` (`lib/variable-token-kind.ts`)
lifts the same ladder this section describes out of the paint, so the editors
and the overlay answer one `{{name}}` identically - the overlay classifies
each `{{name}}` once per repaint, before any paint, and its five ordered
checks exist nowhere else (issue #1239). Read-only editors (response body,
raw request/response, the settings preview) paint no variables - a response
body's `{{x}}` is data someone was sent, not a token the app owns.

**Times are the editor layer's second matcher, gated apart from variables**
(issue #1786). `TIME_TOKEN_MATCHERS` (`lib/monaco-time-tokens.ts`) finds
every span `parseTimeValue` accepts - ISO 8601, the three HTTP date forms,
epoch seconds and milliseconds - in `json`, `javascript` and `graphql` as a
string literal whose whole content is a time or a bare 10- or 13-digit
number, and in `plaintext`, `yaml`, `xml`, `html` and `http` (the Raw tab, so
a `Date:` header and a `Set-Cookie`'s `Expires=` are marked) as a time-shaped
run anywhere, quoted or not. The range is the time itself, never its quotes; near
misses (`2026.10.05`, `20261005`, sixteen digits) find nothing. A time gets a
faint dotted underline (`vayu-time-token`) and, on hover, the same rows
`TimeValue` shows (`TimeHoverCard`, from `describeInstant`) in the tooltip
shell the variable card uses (`EditorTokenTooltip`). It has no popover, no
click and no chord: there is nothing to edit. Unlike a variable it needs
neither an editable editor nor a provider, so it runs in every `CodeEditor`
whose language has a time matcher, the read-only response viewers included.
`CodeEditor` draws the card itself (`TimeTokenCard`, from the hook's
`timeHover`), because most of those editors have no provider above them.

**Outside Monaco, a time is `TimeValue`** (issue #1786,
`components/shared/TimeValue/`). It takes an instant (`Date`, epoch
milliseconds) or the raw text an API sent, and a `style`: `datetime`, `date`,
`time`, `time-ms` (a live row that needs milliseconds), `relative`, or `raw` to
keep a string as it arrived. It renders a `<time>` whose tooltip is
`TimeHoverCard`: one `dt`/`dd` row per `describeInstant` row (the zone the OS
resolves, UTC, how long ago, and the original text when it differs), plus any
`extraRows` the surface adds, such as the run a restored response came from.
The card builds its rows when it opens, so a virtualised list pays for the
text only. A value that is not a time renders as plain text with no card, so a
surface can hand it whatever it holds. A string that cannot hold an element
(an `aria-label`, a native `title`, a palette subtitle) uses `formatInstant`
from `lib/time-value.ts` with the same style names; `formatDayHeading` writes
the history sidebar's day headings. `TimeTooltip` is the card on a trigger the
surface draws itself: the history row hangs it off its stretched activator,
with the status as an `extraRow`. API data in a table is
decided by `parseTimeValue` alone, never `new Date()`: `HeadersViewer` wraps
each time run of a header value (`proseTimeRuns`, the Raw tab's own reading)
in a `TimeValue` and leaves the rest of the text as received, and an editable
value - `KeyValueRow`'s headers and params, the variables table's value cell -
gets a `TimeMarker`, a clock button carrying the card, because an `<input>`
cannot hold an element and a tooltip on the field would open on every focus.
`KeyValueRow` puts it in the resolved peek's column (the peek wins on a row
with a variable); `VariableRow` puts it inside the field and never on a
secret. **`time-surfaces.test.ts` is the guard**:
it reads every non-test source file under `app/src`, asserts the scan is
non-empty, and fails on `toLocaleDateString`, `toLocaleTimeString`,
`toLocaleString` on a Date, `Intl.DateTimeFormat`, `Intl.RelativeTimeFormat` or
an import of the retired `lib/format-time` anywhere but `lib/time-value.ts` and
`components/shared/TimeValue/`, and on a `CodeEditor` that gains a prop to opt
out of the time matcher. `Number#toLocaleString` for counts stays. A test that
renders a `TimeValue` needs a `TooltipProvider`; `test/render-with-tooltips.tsx`
supplies one.

**Script (`javascript`) editors are decorated too, on three different
readings** (issue #1220 script support - `lib/script-variable-tokens.ts`,
gated per language by `VARIABLE_TOKEN_MATCHERS` in `monaco-variable-tokens.ts`,
a different gate from `BODY_LANGUAGES`, which stays the `{{` **completion**
list's own list and does not offer brace completion in a script):

- The string-literal argument of `pm.environment.get(...)`,
  `pm.globals.get(...)`, `pm.collectionVariables.get(...)`,
  `pm.variables.get(...)` and `pm.iterationData.get(...)` - a real read,
  painted and hoverable and (where the scope is writable) editable like a
  body token, but classified against only what that one accessor can see
  (`classifyScriptToken`, `lib/variable-token-kind.ts`): one scope's own
  answer for the first three, the whole merged ladder for `pm.variables` (the
  same answer a body token gets), and the bound data row alone for
  `pm.iterationData`. A setter (`pm.environment.set(...)`) is never matched -
  only `.get` is a read - and a name inside a `//` or `/* */` comment is
  excluded by the same scan that finds the accessor calls.
- Every `{{name}}` inside a `pm.variables.replaceIn(...)` call's template
  argument - the one place a script really is interpolated - gets the full
  body-language treatment: the merged ladder, no accessor to narrow it.
- A **bare** `{{name}}` anywhere else in a script is muted
  (`vayu-variable-token-runtime`) and read-only: hovering explains that the
  script never interpolates it (the same sentence the "Names mentioned" chip
  row already gives it, `TEMPLATE_IN_SCRIPT_NOTE` in
  `lib/referenced-variables.ts`) and names `pm.variables.replaceIn` as the
  fix, but there is no popover - editing a value the script will never read
  at runtime would be actively misleading.

Excluding a read-only editor is one mechanism now, not two (issue #1320). The
paint, the hover card and the popover are all installed by
`useEditorVariableTokens` - one call, per editor - and the gate is per
matcher inside it (issue #1786): the variable matcher only with a provider
above an editable editor, the time matcher wherever the language has one.
There is no model left to mark and no per-language provider left to answer
for one anyway. That is simpler than the
two mechanisms this used to take: a Monaco hover provider is registered per
*language*, not per editor, so the `json` provider answering for a request
body was the same
object Monaco asked about a response body, and an editor that painted tokens
had to mark its model (`lib/variable-token-models.ts`, since deleted) for the
hover to tell them apart. `readOnly` could not decide it either way - that is
an editor option, and the provider was handed a model.

**A `data.*` token has three states of its own** (issue #600), decided by
`describeDataToken` against `VariableSupport.dataColumns` - the contract the
collection chain declares, resolved leaf-to-root by `resolveDataContract`:

| In scope | Paint | Tooltip |
|----------|-------|---------|
| the column is declared | muted | "Data column - bound per iteration", naming the declaring collection |
| a contract exists, the column is not in it | **amber** (`text-warning-text`) | "Not a declared column of X", listing what is declared |
| no contract anywhere in the chain | muted | "Bound by the run's data file / per iteration" |

Amber rather than the destructive red an unknown variable gets: an undeclared
column still binds if the run's file carries it, so this is "check this", not
"nothing can ever answer this". None of the three offers to create a variable.
The `{{` autocomplete offers declared columns as a **Data columns** group beside
Variables and Dynamic.

**This chip row lives beside a `script.pre` / `script.post` element's editor
now** (issue #1553), as `ScriptReferencesRow` (`components/shared/`) - split
out rather than restored, because the row now has two hosts and used to have
two copies. Through issue #1075, both the request builder's script panel and
the collection's Script tab painted a **"Names mentioned:"** row above their
Monaco editor - `referencedVariables` (`lib/referenced-variables.ts`) split
`pm` reads from `{{template}}` mentions (issue #659, decision D16: the engine
never interpolates script source, so a green `{{base_url}}` chip promised a
substitution that never happens), and `describeDataToken` /
`describeColumnReference` / `describeScopedRead` painted the same
`DATA_TOKEN_TONE_CLASS` (`lib/data-token-tone.ts`) both the URL bar and the
Data tab's column audit use (issue #604), so a column one surface calls
declared is the one every other surface calls declared. Both script panels
were retired for a `script.pre` / `script.post` element edited through
`ElementList`'s bespoke form (`ScriptElementForm`,
`components/shared/ElementList/`) - a primitive under `components/shared/`
that cannot depend on either host's context, the same rule that keeps this
row out of it. `ScriptReferencesRow` instead takes the resolved answers
(`script`, `allVariables`, `getVariableOrigins`, `dataColumns`) as props, and
each host - `ElementsPanel.tsx`, `ElementsTab.tsx` - supplies its own
context's answers through `ElementList`'s `renderAboveForm`, a plain
per-element render callback that keeps `ElementList` itself as
context-free as before. One deliberate behaviour change from the two retired
panels: an ordinary `pm.*.get()` read now paints the resolved/unresolved
(`secondary`/`destructive`) pair on both hosts, where the collection's
`ScriptTab` previously painted every such read with a flat accent regardless
of whether anything defined it - the two panels had quietly drifted apart on
this one state, and a single shared implementation cannot paint it two ways.

**A reference carries what its accessor can see, not only how it was spelled**
(issue #1063). `referencedVariables` matched three accessors and left
`pm.variables` and `pm.iterationData` out, so a name read through either was
chipped nowhere at all - the quiet half of the written-but-never-read defect,
and the half no colour assertion catches. Each reference now also carries a
`reads` of `scope`, `merged` or `row`, because since #1007 a bound row answers
bare column names through `pm.variables`: the same name through
`pm.environment.get` is a variable read and through `pm.variables.get` may be a
column one, so the syntax alone can no longer decide what a chip may claim. The
decision is `describeColumnReference`'s, beside the helper, and it answers with
`describeColumnToken` - the same three states `describeDataToken` reaches for a
`data.*` name, split out of it so the prefixed and bare spellings share one
rule. A `row` read is a column in every state it can
be in, including "no contract declared", while a `merged` read is a column only
while the name is a declared column no scope defines, which is the line
`VariableInput` already draws for a bare `{{email}}`. Everything else keeps the
paint it had.

**A reference also carries *which* scope it reads, and a scoped read that its
own scope answers emptily is amber** (issue #1196). `reads: "scope"` said that
one scope answers and never which, so both chip rows could only ask
`allVariables` whether *any* scope defines the name - an answer about the winner
of the full ladder. An enabled, empty `shop_domain` at collection scope
therefore got the healthy accent while `pm.collectionVariables.get` returned
`''` and `{{shop_domain}}` in the URL bar resolved the environment's value: a
failing assertion with nothing on screen connecting it to its cause, and the
usual way in is a Postman import's initial-value placeholder. Each reference now
carries a `scope` of `environment`, `collection` or `global`, null for the
merged and row reads and for a template mention, and `describeScopedRead`
(beside the helper, so the two surfaces cannot disagree) joins it against
`useVariableResolver`'s `getVariableOrigins` - which both panels were already
handed and neither read. The chip is amber when that scope's own **last enabled**
definition is empty or absent while **the ladder's winner** is a different scope
holding a non-empty value, and the tooltip names both facts: what the read
returns, and where the value the author is looking at lives. The winner is the
test, not "some other scope has a value", because the two part company exactly
where the read's own scope is the one that wins: an empty collection row beside a
non-empty global is the collection's answer *and* the merged answer, and an
enabled environment row wins whatever it holds, so neither can be shadowed by
anything. Amber on those would be amber on healthy scripts. Amber and not destructive, for the same reason the
undeclared column is: the read works and the name resolves, it just does not
resolve there. The merged read never warns - `pm.variables.get` returns the
winning value and is the escape from this trap - and the tooltip prints sources
(`environment - Staging`), never values, because a shadowing definition may be a
secret. The engine is correct here and untouched: `js_pm_scope_get` returns the
stored empty string when an enabled row holds one, and `undefined` when none
does, which is exactly what these two states say. **The completion list inside
the accessor now says the same thing at typing time** (issue #1302): it offers
the scope's own definitions rather than the ladder's winners, so the trapped
name is offered at all, and its `detail` is `describeScopedRead`'s sentence -
one function, two surfaces, rather than a second cross-check written beside it.

**A run-time token receives pointer events; the overlay does not.** The overlay
is `pointer-events: none` so clicks reach the transparent input underneath and
place the caret, and each token wrapper opts back in for itself -
`EditableVariable` because it opens a popover, `RuntimeToken` because a tooltip
*is* its whole content and cannot open without a pointer event (issue #604: it
never had this, so neither `{{$guid}}` nor `{{data.email}}` could be hovered).
Opting in costs the caret, so the token carries the offsets of its own text and
a click puts the caret at the **near edge** - before the token when its left
half was clicked, after it when its right half was. The edges, not a position
inside: `{{data.email}}` is one atom to everything that reads it, and a caret
between its braces is how a keystroke corrupts the name.

**The keyboard splits the overlay the same way the pointer does, and along the
same line** (issue #1215). The layer used to be `aria-hidden="true"` as a whole,
which is right for what it mostly is - a repaint of text the `<input>` beneath
already carries - and wrong for the one thing it also holds: an editable token is
a `role="button"` that opens the variable editor, and a focusable control inside
an `aria-hidden` subtree is the `aria-hidden-focus` violation. Two commits that
never met, each correct alone. So the duplication now carries the attribute where
it actually is - the literal text either side of a token, which the input does
carry - and the tokens stay in the accessibility tree.

**Both kinds of token, and the run-time one took a second pass to get there**
(issue #1238). #1215 left it hidden on the grounds that it is not focusable,
which was true and is the reason it should not have been: its tooltip is its
*entire* content, and it carries the only statement of where the value will come
from - the generator's description, `not generated here` for an identity, and the
amber "Not a declared column of …" that is how a drifted contract is spotted at
all. All of it was mouse-only. A `tabIndex` on the trigger is the whole fix,
because Radix opens the tooltip on focus and points `aria-describedby` at what it
opened; the editable token's other half - `role="button"` plus Enter/Space - is
deliberately **not** copied over, since nothing about a run-time token is
activated and announcing a button that answers no key is worse than announcing
nothing. A disabled field drops every token to `-1`, both kinds alike.

They share **one** Tab stop between them, roving: the token holding it has
`tabIndex={0}` and the rest `-1`, Left/Right move between them and Home/End jump
to the ends, and whichever token takes focus keeps the stop. Without that, a URL
with five variables put five stops between the URL and Send. It is the roving
tabindex `design-system.md` describes for the collection tree, hand-wired rather
than taken from the tree's machinery: `useRovingTreeFocus` navigates
`[role="treeitem"]` and dispatches at the tree's own data attributes, so pointed
at tokens it would silently do nothing, and `focusTreeRow` (`tree-focus.ts`)
moves the stop by writing `tabIndex` onto DOM nodes - correct for rows that do
not re-render for it, wrong for a strip whose stop is a React prop. Arrowing
deliberately does not wrap - falling off the end leaves Tab as the way out.
Locate the layer in a test by `data-variable-overlay`, never by `aria-hidden`,
which now names the parts rather than the whole - and enumerate the strip by
`[data-variable-token] [tabindex]`, never by `[role="button"]`, which is the
editable token's trigger alone and quietly stopped meaning "a token" when the
run-time ones joined the strip.

**The field is a combobox, and it steers its own list.** `VariableInput` carries
`role="combobox"`, `aria-autocomplete="list"`, `aria-expanded`, `aria-controls`
and a live `aria-activedescendant` - but only where a list can actually open
(a scope, or plain suggestions), because promising a list a screen-reader user
then cannot find is worse than promising nothing. The arrows and Enter are
handled on the input: `cmdk` reads them off its own `Command.Input`, which
neither `VariableAutocomplete` nor `SuggestionList` renders, so before #1215 the
keys were faked by dispatching a synthetic keydown at
`document.querySelector("[cmdk-root]")` - the first `cmdk` list in the
*document*, of which the app mounts four - and Enter clicked whatever
`[cmdk-item][data-selected="true"]` it found there. Both lists are now driven
through `cmdk`'s controlled `value` / `onValueChange`, stepping through the one
ordering `lib/variable-suggestions.ts` builds and `VariableAutocomplete` draws.
`cmdk` mints the listbox and option ids after the props it is handed, so
`CommandListboxProbe` reports them from inside the list for `aria-controls` and
`aria-activedescendant`.

**The field moves the highlight; the list scrolls it.** That split is not free:
`cmdk` schedules its scroll inside `setState("value", …)`, the path its own
`Command.Input` arrow handling takes, and a highlight arriving through the
controlled `value` *prop* lands in a layout effect that assigns and emits with
no scroll at all. So the highlight walked to the right row and the list stayed
where it was - past the eighth entry, below the fold of `CommandList`'s
`max-h-[300px]`, the only way to see what Enter would insert was the mouse
(#1333). `CommandScrollIntoView` closes it the way `CommandListboxProbe` closes
the ids: mounted inside the list, reading the highlight from `cmdk`'s store
rather than from a prop, so a row the pointer highlighted and one the arrows
reached take one code path - `cmdk` opts its own pointer handler out of
scrolling, and `block: "nearest"` is why matching them costs nothing, since a
row under the pointer is on screen already. A group's heading rides in with the
first row of that group, matching `cmdk`, because the headings are what tells a
generator from a stored variable.

`EditableVariable` takes the scope as a **required** prop, because a token only
renders where there is one. `RuntimeToken` serves all three run-time cases - a
value produced when the request is sent rather than stored anywhere - and is one
component rather than three because they differ only in the words of the tooltip.

The namespace checks come **before** the scope lookup deliberately: `data.*` and
the identity names are both disjoint from the tiers, so a variable someone
happens to name `data.email` or `$vu` neither answers for the column or the
identity nor may paint the token as though it had. Reading
the scopes first would show a resolved token carrying a value the engine will
never send. The create offer is out of reach for both - a variable of either
name can never resolve, so offering to make one is a dead end that leaves the
token exactly as it was - but by two different mechanisms: `VariablePopover`
refuses it for a `data.*` name itself (`isDataVariableName`), while an
identity name never reaches the popover at all, the branch above returning
before `EditableVariable` is rendered.

**The popover names a bound row as the origin, above what it beat** (issue
#1064). The token paint above is unchanged - a shadowed bare name still paints
in the accent - but opening `VariablePopover` on one while a row is picked and
its column answers the name now lists the row first, unstruck and labelled the
origin, with the scope definitions it outranks struck beneath it.

Hovering moved with it, and had to: hovering reads and clicking edits are two
readings of one token, so a tooltip still printing the environment's value
while the popover named the row would make a single token say two things about
one send. `EditableVariable` takes the row's answer off the origins it already
fetches - not a prop of its own, so there is one answer to "what wins" and not
two - and shows it with a `Bound row` hint. A cell is never a secret, but a
secret it shadows is still never printed. What did **not** move is the paint:
the token's colour is decided as it always was.

**The list of definitions is drawn under every state, not only the resolved
one** (issue #1083). A name whose every definition is switched off has no
winner, so it does not resolve and reached the popover's undefined states - and
the list was rendered inside the resolved branch alone, so the case it was added
for could not display it. The reader was offered a form to create a name that
already existed and was one toggle from answering. The list now sits outside the
branch chain, gated on holding a definition the popover is not already showing
rather than on a count of entries, and the two undefined states say what it
means: the create offer notes that the name is defined below and switched off,
and the red sentence reads "defined, but every definition is switched off"
instead of telling the reader to go and define it. The red itself stays - the
token genuinely does not resolve. `data.*` is the one state with no list, for
the same disjointness reason it has no create offer.

**The create offer's scope choice is a `ToggleGroup`, and picking one keeps you
in the value field** (issues #1380, #1391). It was three hand-rolled
`role="radio"` buttons with a roving `tabIndex` and an arrow handler of their
own, sharing one flex line with the "create in" label and an `ml-auto` Create
button - 298px of content in a 266px row, so with all three scopes writable the
button painted 21px outside the card, which `PopoverContent` does not clip. Both
halves are primitives now: the choice is the app's segmented control, so Radix
owns the `radiogroup` and `radio` roles, the single tab stop and the arrow keys,
and Create sits in the same `flex justify-end gap-2` footer the edit branch uses
one state over, which is what takes the widest line back inside the card. The
"create in" label stacks above the control rather than sitting beside it, the
way `LoadTestConfigDialog` labels its own: beside it, the segments have 266px
less the label to live in, and the two widest UI faces the appearance settings
offer - System and JetBrains Mono - spend more than that on "Environment
Collection Global". Above it, the widest of the four measures 230px.
Selection follows focus, as a radio group's does - Radix moves the tab stop and
leaves selecting to a press, so each segment picks itself `onFocus` and an arrow
cannot light one segment while Enter creates in another. Enter on the focused
segment creates: a segment that has focus beside a value already typed leaves
Enter nothing else to mean. A mouse click hands focus back to the field, because
picking a scope qualifies the value rather than replacing it as the destination;
as plain buttons the chips kept the focus a click gave them, and the next
keystroke went nowhere. Create is refused while the field is empty:
`mergeVariable` stores what it is handed, so an empty value defines the name as
`""`, which resolves - the token stops reading as undefined and answers with
nothing.

Reaching the list into those states also reached the bound-row note into them,
and it could not be carried over as written: "the definition above still
resolves on a send that carries no row" is exactly what a switched-off
definition does not do, so a row shadowing only off definitions gets the other
sentence - dropping the pick there resolves nothing.

**`VariablePopover` is the mode switch; its two editing branches are their own
components** (issue #1887). `ResolvedValueEditor` (`ui/resolved-value-editor.tsx`)
is the resolved branch: the masked or revealed field, the secret's eye, the
auto-save sentence and manual mode's Save/Cancel, plus `SECRET_MASK`, the
fixed-width mask the origin list reuses. `CreateVariableForm`
(`ui/create-variable-form.tsx`) is the create offer: the value field, the scope
`ToggleGroup`, Create, and the bound-row and switched-off notes. Both are
controlled. The popover keeps the edit buffer, the reveal flag, the picked scope
and the Enter/Escape and auto-save-on-close flow, because `PopoverContent`
unmounts its children on close and the close path is what saves, discards and
resets them; held in the form, a picked scope would not survive a re-open. The
chips beside the name (Secret, `data`, `row`, `undefined`) are `Badge
variant="chip"`.

It sits beside `KeyValueEditor` rather than inside the request builder because
every row of that table renders one: a shared table reaching into a feature
module for its cell input is the same inversion one level down (issue #567).

### Variable scope as a prop (`VariableSupport`)

`VariableSupport` (in `types/ui.ts`) is the variable slice of the request-builder
context - `resolveField`, `getAllVariables`, `getVariableOrigins`,
`updateVariable`, `writableScopes` - as a plain object a caller hands in, plus
the optional `dataColumns` (the declared data contract in scope, issue #600).
`dataColumns` is optional *within* a scope rather than with it: absent means the
chain declares no contract, which is every workspace that has not opened the
Data tab.

`maskSecrets` is the other optional member: `useVariableSupport` builds it from
`getAllVariables()` *at the call*, never at memo time, so the memoised scope
holds no secret text, and it masks with `SECRET_UI_MASK` (`services/codegen`),
the same bullets the Params tab's "Sends" line uses. Absent means the scope
marks nothing secret.

It exists because reaching for the context instead made two primitives
unmountable anywhere but the request builder: `useRequestBuilderContext()`
throws with no provider above it, so `KeyValueEditor`, `VariableInput` and
`EditableVariable` could not render at all elsewhere, and the surfaces that
wanted key/value rows wrote their own instead (issue #564). A hand-rolled copy
of a primitive never receives the primitive's fixes.

The prop is **optional** on `KeyValueEditor` and `VariableInput`, and its
absence is a real state rather than a degraded one: a canned webhook reply has
no variable scope, so nothing resolves, no token paints and no autocomplete
opens. Inside the request builder every mount site passes
`useVariableSupport()`; `AuthPanel`'s `VariableTextInput` calls that hook itself,
since it is always under the provider.

## UI Primitives (`components/ui/`)

Primitives built on Radix UI + cmdk:

`badge`, `button`, `card`, `code-editor`, `collapsible`, `command`, `delete-confirm-dialog`, `dialog`, `dialog-cancel-button`, `disabled-hint`, `dropdown-menu`, `info-chip`, `input`, `secret-input` (masked field with a reveal toggle - client secret / passwords, and the variables table's secret rows, which is where the pattern was extracted from), `kbd`, `label`, `popover`, `resizable`, `scroll-area`, `select`, `progress`, `separator`, `skeleton`, `suggestion-list`, `switch`, `tabs`, `textarea`, `tooltip`, plus variable-aware inputs: `variable-autocomplete`, `variable-popover` (with its two branches, `resolved-value-editor` and `create-variable-form`), `variable-scope-badge`, and markdown: `markdown-view`, `markdown-editor`.

### `input`

`Input` takes a `size` prop, the way `Button` does, and **states its size,
never its height** (#1830). The three sizes are the density-scaled floor
tokens, so Comfortable follows without a call site doing anything. The
size-to-token map is `input-size.ts`, which `VariableInput` reads too, so the
two fields cannot drift:

| `size` | Class | Default | Comfortable | Use |
|--------|-------|---------|-------------|-----|
| (none) / `"default"` | `h-control` | 28px | 36px | A standalone input |
| `"sm"` | `h-control-sm` | 24px | 32px | A dense standalone input: dialog rows, filters, a table-cell editor, a label beside its field |
| `"xs"` | `h-control-xs` | 20px | 24px | A field inside a `target` row: the inline renames in the collection, request, variables and element trees |

`xs` is the one size with more than a height. It is `rounded-sm`, has `px-1`,
and sits left of the row's content edge by its padding plus its 1px border
(`-ml-[calc(var(--spacing)*1+1px)]`), with a width that gives the offset back
on the right. That geometry is drawn for a label a `gap-2` from the icon or
badge before it: the text lands on the label's x, so it does not move when a
rename begins, and the border clears the icon by a step (2px at Default, 3px at
Comfortable). Every rename site writes `size="xs"` and nothing else;
`chrome-floors.test.ts` fails a `px-`, `-ml-` or `w-` beside it. Its border
takes the focus colour in place of the ring, so one edge draws. No `text-box`
trim, ever: with `py-0` it clips descenders and underscores (`input.test.tsx`).
A caller never writes an `h-*`, `size-*` or `h-full` class on an `Input`, a
`VariableInput` or a `SecretInput`: `chrome-floors.test.ts` fails the tag that
does. `SecretInput` forwards `size`, and `id`, which lands on the inner input so a
`<Label htmlFor>` names the field rather than the wrapper `div`. `size` is the variant, not the native
numeric `size` attribute, which `Input` omits.

### `dialog-cancel-button`

`DialogCancelButton` is the only thing that draws a **Cancel** (issue #1693).
The word used to come in three variants - `outline` in five dialogs,
`secondary` in three, `ghost` in three, plus one hand-rolled `<button>` with a
copied class list - so which one a user saw depended on which dialog they
opened. It settles on `secondary`, matching `DeleteConfirmDialog`, and takes
no `variant` prop: a call site that can choose is a call site that can drift.
`label` renames the word, `size` and `className` pass through for the inline
forms outside a `DialogFooter` (the new-collection row, the client-certificate
form) that draw the same button in a denser row.
`dialog-cancel.test.ts` bans the label anywhere else.

### `disabled-hint`

`DisabledHint` says why a control is off (issue #1690). `Button`'s baseline is
`disabled:pointer-events-none` and a disabled button is not focusable, so a
`Tooltip` around it never fires; `DisabledHint` instead wraps the control in a
`span` that keeps its own `pointer-events-auto` and its own tab stop and holds
the tooltip, so the reason shows on hover and on Tab. `reason` is both the text
and the switch: falsy renders the children alone, so a caller passes one
expression (`<DisabledHint reason={empty && "No captures to clear"}>`) rather
than two copies of the control. The gate stays the child's `disabled` prop.
Crossing the gate swaps the child's DOM node, so a test must re-query it. A
disabled menu item is the exception: `RowAction`'s `disabledReason` draws the
reason on the item (see Row and tab actions menu above). The rule and the
wording guidance are in [design-system.md](../design-system.md).

### `dialog`

`DialogContent` is a column flex panel with two caps: `max-w-xl` (the default of
a four-size width scale - `lg` / `xl` / `2xl`, issues #701 and #892, plus the
two-pane `max-w-xl lg:max-w-4xl`, issue #2231) and
`max-h-[85vh]` (issue #773). Anything between the header
and the footer that can grow goes in **`DialogBody`**, which is the band that
scrolls - so the title and the primary action stay on screen and the corner
close button, positioned against the panel, does not scroll away with the
content. The band also carries its own 4px/1px clearance (issue #1627), so a
focused field's outset ring is never clipped by the `overflow-y-auto` that
makes it scroll, and no call site needs to add its own. `ImportModal` and
`CommandDialog` opt out because each already has a
self-scrolling band of its own, and `DeleteConfirmDialog` has no middle at all;
every other call site takes the band, which `dialog-height-band.test.tsx`
enforces. `command` keeps the shape without the primitive: `CommandFooter` is a
`shrink-0` sibling of `CommandList`, so the palette's hints sit outside the one
thing that scrolls. The rules and the measurements are in
[design-system.md](../design-system.md).

The `cva` definitions for `badge`, `button` and `toast` live in sibling
`*-variants.ts` modules and are re-exported from `components/ui/index.ts`. A
module that exports both a component and a value cannot be hot-reloaded, which
is the only reason for the split - import `badgeVariants` / `buttonVariants` /
`toastVariants` from `@/components/ui` as before.

### `progress`

A determinate or indeterminate bar over `@radix-ui/react-progress`
(issue [#882](https://github.com/athrvk/vayu/issues/882)). `value` is a fraction
0..1, or **null** when nothing stated a total to be a fraction of - a download
whose upstream declared no `Content-Length`. Null is not zero and must not
collapse into it: Radix drops `aria-valuenow` for it, and this adds `aria-busy`,
which Radix expresses only as `data-state="indeterminate"` (a styling hook that
tells a screen reader nothing). `label` is required, because a bar is a number
with no noun in it.

The indeterminate stripe animates through `.progress-indeterminate` in
`index.css`, so the global `prefers-reduced-motion` rule collapses it like any
other animation. Every caller of that state therefore also shows a figure that
keeps changing (bytes received): the information is in the text and the motion is
only the hint that something is still happening. Sole consumer so far is
`modules/collections/ImportProgressView.tsx`.

### `info-chip`

The 12px "i" dot with a tooltip, beside a label that needs a sentence -
timing phases, chart axes, the wire/queue/total summary. The hit box is 24px:
an `after:size-target` square centred on the dot, so no row moves. It lived in
`modules/dashboard/components/shared.tsx`, where nothing outside the dashboard
could import it without a module reaching into another module, so the request
builder grew its own copy - and the copy is the one that got the `border-rule`
fix, leaving the original outline-less in dark. The border stays a prop
(default `border-border`, pass `border-rule` on a declared surface) because
`border-rule` falls back to the invisible default where no surface declares one.
`dashboard/components/shared.tsx` re-exports it so existing imports resolve.

### `code-editor`

The single wrapper around Monaco. Every shared editor setting lives here so it
changes in one place, and it is also where Monaco is *loaded* - `ensureMonaco()`
on first mount, a skeleton until it resolves (see `lib/monaco-setup.ts` above).
The other half of its job is making an editor behave like the rest of the app,
because Monaco's defaults are not this app's and there are a dozen mount sites
to keep from each answering that separately (#938, #1213).

**Keyboard.** `lib/editor-chords.ts` binds the first four on every instance, and
`useEditorVariableTokens` the last on the editors that paint variable tokens:

- **The two send chords** (⌘↵, ⇧⌘↵), re-dispatched on `document.body` for the
  one window handler to decide. Monaco owns Enter and `ownsEnterKey` excludes
  editors from that handler on purpose, so without the bridge ⌘↵ inserted a
  newline in the body, GraphQL and script panes.
- **⌘I**, the context-bar toggle, for the opposite reason: Monaco binds
  CtrlCmd+I as a secondary `triggerSuggest` keybinding on every platform and its
  keybinding service stops what it resolves, so the chord died at the editor
  instead of reaching `Shell`'s bubble-phase listener. S, W, B, `,`, the digits
  and the ⇧ view chords really are unbound in the standalone editor and arrive
  on their own - which is what the bridge's comment used to claim about **all**
  of them.
- **⇧⌘M, the way out.** Monaco's Tab indents, which is right for a code editor
  and a keyboard trap for anyone who reached one by tabbing (WCAG 2.1.2).
  Monaco's own exit, `editor.action.toggleTabFocusMode`, cannot simply be
  advertised: it is Ctrl+M, which on macOS means ⌃⇧M - a modifier `Chord` has no
  word for - while the ⌘M this registry *would* render is Minimize. So the app
  declares `LEAVE_EDITOR_CHORD` and the Keyboard Shortcuts panel lists it like
  any other. It moves focus to the first focusable element after the editor's
  container, walking backwards when the editor is the last thing on the page -
  never to the container itself, whose textarea the next Tab would walk straight
  back into.
- **⇧⌘D, the variable under the cursor** (issue #1220). A `{{token}}` in a
  Monaco editor is painted text, not a `role="button"` a Tab can reach, so the
  mouse route into its popover (⌘/Ctrl-click) has no keyboard twin to inherit.
  `EDIT_VARIABLE_CHORD` is that twin: it reads the caret's own position, and it
  is bound where the token decorations are - per editor, in
  `useEditorVariableTokens` - because which variable to open is a question only
  the editor holding the caret can answer. Registered only where variables are
  painted, so a read-only viewer never carries it - not even one whose times
  are underlined, which have nothing for a chord to open. A script editor does (issue
  #1220 script support): the caret on a `pm.<accessor>.get(...)` argument or a
  `replaceIn(...)` template opens the popover the same way a body token does;
  on a bare `{{name}}` it does nothing, the same guard that keeps a plain click
  from opening one - there is no stored variable behind a mention the script
  never reads.

**A read-only editor has no trap to escape**: `tabFocusMode` is simply on for
it, Tab having nothing to indent in text nobody can type into, so it shows no
hint. The binding is still registered there, redundantly - one `addCommand` on
every instance is cheaper to keep true than a `readOnly` branch threaded through
the bridge. Editable editors keep Tab and show a `Kbd` hint naming the chord
*while they hold focus* - at the moment it is wanted, rather than as a standing
badge over a dozen panes. The hint is the app's one surface floating over
Monaco's own canvas rather than a declared app surface, so it carries
`border-border-strong` explicitly: there is no `--rule` for `border-rule` to
inherit, and neither theme's `--popover` separates from the editor background on
its own.

⌘K is not bound here at all. It belongs to `CommandPalette`, on the capture
phase, which both prevents **and stops** it: preventing alone left the event in
flight, and Monaco - which treats ⌘K as a chord *leader* - entered chord mode
behind the open palette, so the next keystroke answered "not a command" in its
status bar.

**`ariaLabel` is required.** Monaco's default accessible name is "Editor
content", so a dozen unlabelled panes are one control to a screen reader. It is
per call site rather than derived from `language`, because two editors can share
a language and never a job (the GraphQL variables pane and a JSON body are both
`json`). The type holds the prop present; `code-editor.aria-label.test.tsx`
holds the labels non-empty and distinct, with a floor under the mount count so a
broken scan cannot pass vacuously. The two script panels take theirs from
`SCRIPT_VARIANTS`, the collection script tab from its `kind` - a scan cannot
follow either, which is the same limit that applies to class names arriving in
a variable.

**Themed, not Monaco's default.** `theme` is `vayu-light` or `vayu-dark`
(#1321), never Monaco's own `vs` / `vs-dark` - both are defined once in
`lib/monaco-theme.ts`, inheriting the built-in theme's syntax colours and
repainting only the chrome (suggest list, find widget, hover card, context
menu) from the app's own tokens. Registration happens as Monaco composes
(`lib/monaco-setup.ts`, above), because an editor created before the app's
theme is defined falls back to `vs` and never revisits it; `useMonacoTheme`
then redefines the active theme whenever the mode or accent scheme changes,
from a `MutationObserver` on `<html>` rather than a React effect - `<Editor>`
is this component's child, and a child's effects run before its parent's.
`lib/monaco-theme.test.ts`, `code-editor.theme.test.tsx`, and the sixth case in
`monaco-setup.contributions.test.ts` guard it.

### Markdown (`markdown-view`, `markdown-editor`)

`MarkdownView` renders a description; `MarkdownEditor` wraps it in the
click-to-edit field used by the request **Info** tab and by
`CollectionDetail/InfoTab`. Both fields stored markdown and rendered none of it
before this existed - the collection one even advertised "Markdown supported"
beside a plain textarea.

**Three rules are load-bearing, not stylistic:**

1. **`MarkdownView` never emits a navigating anchor.** The preload re-runs on the
   new origin, so a clicked `<a href>` would hand `window.electronAPI` to
   whatever site it landed on. Descriptions arrive from imported Postman /
   Insomnia / OpenAPI files, which are third-party documents. Links therefore
   render as `<button>`, with no `href` in the DOM, and open via the
   scheme-validated `openExternalUrl` IPC. `remark-gfm` autolinks bare URLs, so
   that override covers those too. Guarded by `markdown-view.test.tsx`.

   This is no longer a single layer: #822 landed the refusal underneath it, so
   `electron/window-navigation.ts` makes the main window refuse a navigation that
   is not the app's own document and deny `window.open`. There is still no CSP.
   Keep both - the window guard turns an escaped link into a dead one, and this
   override is what makes it reach the user's browser instead.
2. **`react-markdown` with the default `urlTransform`.** It builds React
   elements from an AST, so there is no `dangerouslySetInnerHTML` and no
   sanitiser to forget. Overriding `urlTransform` disables the built-in URL
   sanitising (there is a published advisory for exactly that), so it stays on
   the default.
3. **Raw HTML renders, and `rehype-sanitize` runs immediately after
   `rehype-raw`.** `rehype-raw` used to be deliberately absent, which made raw
   HTML inert - fine until Stripe's official OpenAPI document turned out to
   write every operation description as HTML (`<p>Retrieves…</p>`), which is
   spec-legal and was on screen as literal text. The order is the rule: sanitise
   before the raw HTML is parsed and it sanitises a tree the payload is not in
   yet. The schema is derived from the component's own element allow-list, keeps
   `href` on an anchor and **no other attribute** (`class` least of all - the
   cheap attack is `<p class="fixed inset-0 z-50">`, not a script), passes
   http(s) only, and strips `script` and `style` whole rather than unwrapping
   their text onto the screen. Guarded by the benign and hostile blocks in
   `markdown-view.test.tsx`, which are also what pin the plugin order.

The pipeline itself - `react-markdown`, the plugins, the schema and the
component overrides - lives in `markdown-renderer.tsx`, which `MarkdownView`
loads through `React.lazy` (#1146). `MarkdownView` reaches the entry chunk
through the `ui` barrel, so an eager parser chain here was ~300KB parsed on
every cold start for a panel most sessions never open. The three rules above
are unchanged by that: they live with the pipeline. What it changes is the
tests - a case that asserts rendered output has to let the chunk arrive first
(`markdown-view.test.tsx`'s `renderView` helper is the shape).

`MarkdownEditor`'s rule is **focus, not dirtiness**: rendered while unfocused,
source the moment you click in. The caret goes to the end - mapping a rendered
offset back to a source offset needs a real WYSIWYG editor. `keepSourceOpen`
holds the source open for a caller whose save failed, and a source pin (Obsidian's
"source mode") lets you read your own markdown without editing.

### `suggestion-list`

A plain-text dropdown on the shared `Command` primitive, used by
`VariableInput` for header-name suggestions. It replaced a hand-rolled copy in
that file - its own selected-index state, five keyboard branches, a render-phase
index reset and a 200ms blur timeout - all of which `cmdk` already did, two
branches away in the same component, for variables.

## Component Patterns

### Context for module-local state

`RequestBuilder` uses React Context (`RequestBuilderProvider`) for editing state and the execute/save/load-test callbacks, so deep children read it without prop drilling.

### Compound components

Radix-based primitives use the compound pattern, e.g.:

```tsx
<Tabs value={tab} onValueChange={setTab}>
  <TabsList>
    <TabsTrigger value="info">Info</TabsTrigger>
  </TabsList>
  {/* content rendered conditionally on `tab` */}
</Tabs>
```

### Controlled inputs

Form inputs are controlled; values flow from module context/stores and changes flow back via callbacks/mutations.

## State Management in Components

- **Local `useState`** - component-only UI state (dialog open/close, window maximized, window width).
- **Zustand stores (`stores/`)** - tabs (`useTabsStore`: open/active/add/close/focus), layout (`useLayoutStore`: drawer open/view/width, context bar open, response position and its two split ratios), dashboard metrics (`useDashboardStore`), variables (`useVariablesStore`), save (`useSaveStore`), engine connection, session (active environment), history filters, import-modal open-state.
- **TanStack Query (`queries/`)** - server state: collections, requests, runs, environments, globals, health, script completions, OAuth 2.0 token status; mutations for create/update/delete (and OAuth token fetch/clear).

## Component Communication

- **Props / callbacks** - parent↔child.
- **Context** - module-local shared state (request builder).
- **Stores** - cross-module UI state + navigation.
- **Queries/mutations** - engine-backed server state.
