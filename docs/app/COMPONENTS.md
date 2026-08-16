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
│   ├── AppIcon (Windows only - the system-menu control)
│   ├── <CommandSearchBar />             // Input-shaped trigger for the ⌘K palette; never its own search
│   └── EnvPill + WindowControls (Linux only; Windows native overlay; macOS traffic lights)
├── <UpdateBanner />
└── <Shell />                            // components/layout/Shell.tsx - tab-centric layout with drawer + context bar
    ├── <ImportModal />                  // modules/collections/ImportModal.tsx - global overlay, open-state in a store
    ├── <CommandPalette />               // modules/palette/ - ⌘K overlay; open-state in layout-store
    ├── <Drawer />                       // components/layout/Drawer.tsx - resizable 220–480px; single left nav; switches views
    │   ├── <CollectionTree />           //   collections view (default)
    │   ├── <HistoryList />              //   history view
    │   ├── <VariablesCategoryTree />    //   variables view
    │   ├── <ServicesPanel />            //   services view - modules/services/
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
    │   └── <InboxView />                // type="inbox"       modules/inbox/
    ├── <ContextBar />                   // components/layout/ContextBar.tsx - 252px; sections from context-bar/registry.ts; push ≥1200px / overlay <1200px
    └── <Dock />                         // components/layout/Dock.tsx - drawer view switchers + engine/save status + toggles
```

## App Shell

### `App` (`App.tsx`)

Root component. Renders `<TitleBar />` over `<Shell />`. On mount it wires up app-wide concerns via hooks/queries: OS/Electron theme sync (`useElectronTheme`), engine health polling (`useHealthQuery`), and prefetching of server state (`usePrefetchCollectionsAndRequests`, `useRunsQuery`, `useScriptCompletionsQuery`).

### The two chrome rows

Top chrome is 32px + 32px, and the split is what makes both halves work:

```
[ icon | ............ centered search bar ............ | env switcher | controls ]  <- title row, --titlebar-height
[ drawer header band | tab strip over main + context, left edge = drawer edge    ]  <- --tabstrip-height
[ drawer body        | main content                    | context bar             ]
[ dock                                                                           ]
```

The title row belongs to the **window** (it is what drags it, and what the macOS traffic lights and the Windows caption overlay are drawn into); the second row belongs to the **content**. Tabs switch the main area and the context bar and never the drawer, so the strip is scoped to that column and its left edge follows the drawer's resize handle - it is the drawer's flex sibling, so there is no width to keep in sync. The drawer's own half of the row is `DrawerPanel`'s header band.

Both rows are tokenized: `--titlebar-height` (mirrored in `electron/constants.ts`, which sizes the real window frame and cannot read CSS) and `--tabstrip-height` (renderer-only - nothing the main process draws is that tall). `titlebar-height.test.ts` holds each token to its readers, and a top-anchored toast subtracts **both** (`constants/toast.ts`).

Tabs used to live in the title row. They are content-width and overflow into a dropdown, so every pixel another control took there converted directly into overflowed tabs - which is why a search bar could not simply be added beside them.

### `TitleBar` (`components/layout/TitleBar.tsx`)

Custom window title bar (Electron frameless window, `--titlebar-height`). Renders nothing outside Electron - there is no window chrome to draw. A 3-column grid (`1fr auto 1fr`), so the search bar is centred on the *window* rather than on whatever space the two clusters leave.

- **All platforms:** `<CommandSearchBar />` (centre), `EnvPill` (right).
- **macOS:** Native traffic light inset (`--traffic-light-inset`, 104px left); no HTML window controls.
- **Windows:** App icon as the system-menu control (left); native window overlay, no HTML controls in the bar.
- **Linux:** Custom HTML min/max/close buttons (right).

The entire bar is marked as a drag region (`WebkitAppRegion: "drag"`) except for interactive elements, which explicitly set `no-drag` - a drag area ignores every pointer event, so a control that forgets is dead rather than merely awkward. Opting out per control or per cluster is fine; opting out a wrapper that spans the row's slack is not, because that slack is what the window is dragged by. → `TitleBar.search-bar.test.tsx`.

The logo is imported as a module (`@shared/icon_png/...`), not referenced as `/icon.png`. With `base: "./"`, a root-absolute path resolves against the filesystem root under the packaged `file://` build and silently fails to load - it only appears to work in dev, where Vite serves it over HTTP.

### `CommandSearchBar` (`components/layout/CommandSearchBar.tsx`)

The palette's visible entry point, in the title row. A `<button>` styled as an input: it looks like a field because that is what makes ⌘K discoverable, but typing happens in the palette's own input - a real field here would be a second query state and a second ranked list to keep in step. Clicking sets `paletteOpen`; the hint it prints comes from `PALETTE_CHORD` (`constants/shortcuts.ts`), the same constant `CommandPalette`'s listener matches, so the bar cannot advertise a chord nothing handles.

### `TabStrip` (`components/layout/TabStrip.tsx`)

Horizontal row of open tabs plus a "+" button, rendered by `Shell` over the content column (not in the title bar). Reads from `useTabsStore` (open tabs, active tab, add/close/focus methods). Takes its height from `--tabstrip-height` and carries no `app-region` markers - nothing down here drags the window.

Labels and icons come from `tab-descriptors.ts`, a sibling module rather than this file, because the command palette lists the same tabs and must name them identically - a tab that reads "GET /v1/orders" in the strip and "Request" in the palette is two answers to one question.

- **One tab per open entity**, deduplicated per type and `entityId`. Tabs show: icon (method badge for requests, folder for collections, lightning for dashboard, etc.), label (request method + URL path / collection name / screen name).
- **Max 12 tabs** with LRU eviction when exceeding; dashboard tabs are exempt from eviction. Dirty tabs (unsaved) are skipped during eviction (autosave is the safety net).
- **Middle-click closes** a tab (browser-like).
- **No unsaved dot** - autosave ensures safety.
- **Keyboard support:** ⌘1–9 jump to tab; displayed via dock shortcuts.

### `Shell` (`components/layout/Shell.tsx`)

Main layout: tab-centric with resizable drawer, split/overlay context bar, and docked footer.

- **One uniform layout for every tab** - `Drawer` (left) + a content column holding `TabStrip` over main + `ContextBar`. No tab type takes over the row. This is deliberate: the Dock's drawer switchers always have a Drawer to act on, so they can never be dead. (Settings used to full-take-over and suppress the Drawer, which left those buttons doing nothing while Settings was open.)
- **Left navigation is always the Drawer.** Every main view that needs a category/entity list uses the shared Drawer for it - never its own left rail. `SettingsMain` and `VariablesMain` are pure content panes; their category trees live in the Drawer (`settings` / `variables` views). Follow this pattern for any new view - do not add a second sidebar inside the main area.
- **Keyboard handlers:** ⌘S (save), ⌘W (close tab), ⌘B (toggle drawer), ⇧⌘E/H/U/S (drawer views), ⌘I (toggle context bar), ⌘, (open settings tab). ⌘K (command palette) is **not** in this map - it is owned by `CommandPalette`, on the capture phase, because Monaco swallows the key on the bubble.
- **Drawer:** toggles visibility via `toggleDrawer()` (state in `useLayoutStore`); always resizable 220–480px.
- **Content routing:** switches main area based on `activeTab.type` (welcome | request | collection | dashboard | run | variables | settings). Default is `WelcomeScreen`.
- **Drawer-view sync:** an effect points the Drawer at the view matching the active tab - `variables`→variables, `settings`→settings, `request`/`collection`→collections - and opens it.
- **ContextBar mode:** picks "push" (≥1200px width) or "overlay" based on window width. It renders on the tab types the section registry has entries for - request, collection and run - and nothing on the other four. `relative` sits on the main+context row rather than on the outer one, so the overlay stops at the tab strip instead of covering the tabs it belongs to.
- **The restructure must not remount tab content.** Drawer state is upstream of the column the active tab renders into, so a `key` derived from it - or a wrapper mounted only while the drawer is closed - throws away an unsaved body, a scroll position, a Monaco model. → `shell-tab-identity.test.tsx`.
- **`<ImportModal />`** and **`<CommandPalette />`** mounted once each as global overlays; visibility in a store rather than in the Shell.

### `Drawer` (`components/layout/Drawer.tsx`)

Resizable sidebar (220–480px default, per view). The single left navigation for the whole app - one of five views per `useLayoutStore.drawerView`. Every view is titled: its `DrawerPanel` header is the drawer's half of the second chrome row, sharing `--tabstrip-height` and its bottom rule with the tab strip across the resize handle, with an optional tools slot beside the title.

| View | Component | Band tools today |
|------|-----------|------------------|
| **`collections`** | `CollectionTree` (hierarchical collections + requests) | add collection, add request, import |
| **`history`** | `HistoryList` (past runs, filtered/sorted) | run count |
| **`variables`** | `VariablesCategoryTree` (globals, collections, environments) | - |
| **`services`** | `ServicesPanel` (webhook inboxes, OAuth issuers, mock servers) | new inbox, new issuer |
| **`settings`** | `SettingsCategoryTree` (app + engine setting categories) | - |

Both `variables` and `settings` follow the same nav/content split: the tree lives here in the Drawer, the editor is the corresponding tab (`VariablesMain` / `SettingsMain`), and selecting a category sets the shared store selection **and** opens/focuses that tab.

Resize handle on the right edge (double-click resets to defaults). Visibility toggled by `toggleDrawer()` or ⌘B.

### `ContextBar` (`components/layout/ContextBar.tsx`)

252px panel showing a stack of collapsible sections about the active tab. It owns the frame - landmark, resize handle, header, scroll container, per-section collapse state - and nothing about what any section shows.

- **Push mode** (≥1200px): adjacent to main content, takes layout space.
- **Overlay mode** (<1200px): floats over main content, top-right (absolute positioned, shadow, z-10).
- **Toggle:** ⌘I or Dock button. Visibility in `useLayoutStore`. The button's pressed state is "open **and** the active tab has content for the bar" (`contextBarHasContent`, shared with the bar itself) - `contextBarOpen` alone lit the button up on tab types the bar renders nothing for.
- **Structure:** an `<aside>` landmark ("Context sidebar"), like the Drawer facing it. The resize handle and the header are direct children; the scroll lives on an inner wrapper, so the drag strip and the close button stay put while the sections scroll. The left edge is the handle's own 1px hairline - the panel draws no `border-l` of its own.

#### The section registry (`components/layout/context-bar/registry.ts`)

`CONTEXT_BAR_SECTIONS` is one ordered list of `{ id, title, appliesTo(tab), Component }`. `sectionsForTab(tab)` filters it, and `contextBarHasContent(tab)` is `sectionsForTab(tab).length > 0` - so the bar's visibility and the Dock toggle's pressed state read the same list and cannot drift. Adding a section for another tab type is one entry here and nothing else.

**A section's component is mounted only while its section is expanded** (`context-bar/Section.tsx`), which is the whole cost model: the bar is open on every tab that has sections, so a collapsed section must register no queries. Collapse state persists per section id in `layout-store` (`contextBarCollapsedSections`, collapsed-by-exception).

Sections are leaf components over the existing query layer - no bar-wide shared state - each with its own loading and empty body (`SectionEmpty`, `SectionLoading`).

**Request tab**

| Section (`id`) | What it shows |
|---|---|
| Variables in scope (`variables`) | `VariablesSection.tsx` - the resolved variables and the quick editor over them (below). |
| Auth (`auth`) | `AuthContextSection.tsx` - the effective auth mode and where it came from, via the shared `resolveAuthSource` walk, so it cannot disagree with what is sent. For OAuth 2.0 it embeds `TokenStatusRow` (the Auth tab's own control) for token state, fetch and clear. |
| Cookies for this host (`cookies`) | `CookiesSection.tsx` - the active environment's jar filtered to the request's host, with a per-scope clear. Host filtering is an **approximation**, stated in the UI: libcurl applies the real domain/path/secure rules at transfer time. |
| Code (`code`) | `CodeSection.tsx` - copy-as-curl / copy-as-fetch (below). |
| Environment (`environment`) | `EnvironmentSection.tsx` - the active environment's name and a way into the Variables drawer. |
| GraphQL (`graphql`) | `GraphQLSection.tsx` - schema status, the age of the schema in hand, the endpoint, a Refresh, and an outline of the operations the stored document defines. Status belongs in the bar; *browsing* the schema does not - that is the explorer docked beside the query editor (below). `appliesTo` sees only the tab, which carries no body mode, so the section applies to every request tab and says "does not send a GraphQL body" for the rest, exactly as `cookies` does for a host with no cookies. The outline reads the **stored** request, since the bar sits outside `RequestBuilderProvider` and cannot see the editor's live buffer; autosave keeps the two within a second or two. Each outline row is a button that **scrolls the query editor to that operation** and focuses it, from a hidden Body tab too - the provider brings the tab forward first, because the editor is unmounted anywhere else and revealing into an editor nobody can see is the silent-failure alternative. The row sends the operation's *name*, not the line it drew, and `findOperationLine` resolves it against the live buffer; an operation renamed since the outline was drawn reaches the polite live region instead of scrolling to whatever now sits on that line. The channel is `lib/graphql/reveal-store.ts` (below). |
| Recent sends (`recent-sends`) | `RecentSendsSection.tsx` - the last five design runs of this request, newest first: status chip, latency and age, each row opening that run in a History tab. One `GET /runs` call and no report fetch - status and latency ride on each row as `resultSummary` (see below). A run with no stored result reads "Sending…" or "No result" rather than a status-0 chip, which the wire uses for "reached no server". |

**Collection tab**

| Section (`id`) | What it shows |
|---|---|
| Variables in this collection (`collection-variables`) | `CollectionVariablesSection.tsx` - the definitions this collection owns (not a resolved set), editable through the same commit path as the request tab's list. A disabled definition is shown and marked `off` rather than hidden. |
| Auth (`collection-auth`) | `CollectionAuthSection.tsx` - the mode this collection is set to, and what a descendant set to Inherit would pick up: the same `resolveAuthSource` walk, so a collection set to plain No Auth names the ancestor that answers instead. |
| Contents (`collection-contents`) | `CollectionContentsSection.tsx` - direct child counts (requests, sub-collections), matching what the tree shows under the folder. |
| Last run (`collection-last-run`) | `CollectionLastRunSection.tsx` - how this collection's most recent run went: the outcome word in its status colour, the plan's size (`3 steps`, `× 2` only when more than one pass ran), and the age, opening that run in a History tab. One `GET /runs?collectionId=&limit=1` call and no report fetch - the server's `start_time DESC` makes the single row the answer. A run still going reads "Running" rather than an outcome, and a run stored before the engine sent the `scenario` descriptor shows no size rather than "0 steps". |

**Run tab**

| Section (`id`) | What it shows |
|---|---|
| Run config (`run-config`) | `RunConfigSection.tsx` - mode, duration, target RPS, concurrency, iterations, ramp and requested protocol, read from the run's stored `configSnapshot`. Words come from `loadTestModeLabel` / `formatConcurrency`. A design run has no `mode` key and reads as "Single send". A **collection run** has none of those keys at all - it reads its `scenario` block instead (`run-scenario.ts`) and shows "Collection run", the plan's step count, iterations, and whether sub-folders were included. |
| Source (`run-source`) | `RunSourceSection.tsx` - the environment the run used (`Run.environmentId`, which nothing rendered before) and a link opening the request it ran from. A deleted environment is named as deleted rather than folded into "No environment"; a deleted request (`isRequestNotFound`, never a transport failure) drops the link. A **collection run** links no request - its source is the folder - so the row names the collection and opens *that* tab. |

`run-scenario.ts` is the one place the snapshot's `scenario` block is narrowed
(it arrives as `unknown` through `RunConfigSnapshot`'s index signature). It gates
on `run.type === "scenario"` as well as the key, so a load run whose raw body
happened to carry a `scenario` the engine ignored is never described as one.

The collection and run sections gate on `tab.entityId` as well as the type: a tab open on nothing renders no pane either, and a section there would query nothing while lighting the Dock toggle over an empty bar.

**`collection-last-run` was deferred twice before it landed** (specced in #377, deferred in PR #394 as "no runs exist until #354", re-deferred in PR #400 once the runner existed), each time for the same reason: a collection's runs were not addressable. `GET /runs` filtered by `requestId`, a collection run links none, and the only route to the row was a substring search of every stored snapshot for the collection id - a scan per open bar. #422 added `GET /runs?collectionId=`, which matches the scenario snapshot's own field as JSON rather than its text, and the section is one filtered query for exactly the row it shows.

**There is still deliberately no "last result" section**, and `recent-sends` is not one. Status, duration and age of the *last* send are what `ResponseStatusBar` already paints in the response pane on the same screen - same `StatusCodeBadge`, same stored run, since the builder restores that run into the pane whenever nothing is in memory. A section with no state in which it says something the pane does not say better is a duplicate, not a summary, which is why the specced one was built and removed in #344. What the pane structurally cannot show is *more than one send*, and that is the whole content of `recent-sends`: if it ever narrows to the latest run it is the removed section again. Its id is new rather than reused, so the `last-result` guard in `registry.test.tsx` keeps guarding.

That section is affordable because the paginated `GET /runs` now carries each design run's outcome on its row (`resultSummary`: `statusCode` + `latencyMs`), added for it in #380. Before that, N rows meant N `GET /runs/:id/report` calls, and that path loads and JSON-parses every result's `trace_data`. Load and collection runs carry no `resultSummary` - their results are unbounded - and the engine's query cannot read them even if asked.

**Freshness is wiring, not polling.** `runs.recentDesign(requestId)` is its own key family (like `runs.lastDesign`, and for the same `InfiniteData` shape-clash reason), so nothing under `runs.lists()` refreshes it: the builder's send path, the run view's replay, the MCP `run` event and the delete/clear-history paths each invalidate it explicitly. A new invalidation point for runs needs to touch it too, or the section silently shows the sends from before.

#### Variables section

Resolves the active request's variables (global + collection-scoped + environment) via `useVariableResolver`; each row shows the name (`TruncatedText`), its winning scope (`VariableScopeBadge`) and the value (secrets masked). Value inputs are named `Value of <name>`.

**Editing:** a blur (or Enter) commits the value back to the definition the resolver picked - looked up by `ResolvedVariable.sourceId`, not re-derived (see [variable resolution](./variable-resolution.md#getvariableoriginsname)). The payload is read from the query cache at commit time and patched into it optimistically, so a second blur before the first mutation settles cannot re-send the first one's old value. Commits register with the save store, so a quit flush waits for one in flight.

The row and the commit are shared, not per section: `VariableRow.tsx` draws it (the remount key, the Escape restore, the uncontrolled input a rejected save depends on) and `variable-commit.ts`'s `useVariableCommit` writes it, so the collection tab's list gets the same fixes. Its rows are the collection's own definitions with that collection named as the source, which lands in the same place a collection-scope edit from the request tab does.

#### Code section and `services/codegen/`

Snippets are generated from **`POST /compose`'s output** - the request with `{{variables}}` substituted and `inherit` auth walked by the engine that will send it - so what you paste is what Vayu would put on the wire. A **Templated** mode generates from the stored request instead, references intact, for pasting into a bug report. Composing happens on expand and on an explicit recompose, never per keystroke (the section only mounts while expanded, and the query is `staleTime: Infinity`).

`services/codegen/` holds the generators, closing the symmetry with `services/curl/`, which parses curl *in* and generated nothing out. Each target is a pure function of a `SnippetRequest`; `CODE_TARGETS` is the registry, and adding a target is one entry plus one function. Auth is flattened into headers/query/`-u` in `prepare.ts` rather than per target, because the engine keeps `auth` beside the request and applies it at send time: a snippet built from the composed *headers* alone would authenticate in Vayu and 401 in a terminal. Modes no static command can reproduce (OAuth 2.0, digest, AWS, NTLM) produce a note instead of a silent drop.

**Quoting is per target, never a flag on another one** - that is why PowerShell is its own generator rather than "curl with different quotes". Each language's escape rule and its form-body switch differ in ways that fail silently:

| Target | String rule | Multipart vs urlencoded |
|---|---|---|
| `curl` | POSIX single quotes, `'` → `'\''` | `--form-string` vs `--data-urlencode` |
| `fetch` | `JSON.stringify` (it *is* the JS literal grammar) | `FormData` vs `URLSearchParams` |
| `python` | `JSON.stringify` - JSON's escapes are a strict subset of Python 3's | `files=` vs `data=` (a multipart body passed as `data=` is silently urlencoded) |
| `httpie` | POSIX, shared with curl | `--multipart` vs `--form` (`--form` alone is urlencoded) |
| `powershell` | Single quotes, `'` → `''`; a POSIX `'\''` would put a backslash in the data | `-Form` vs `-Body` |

HTTPie takes headers as bare `Name:value` words and a body as `--raw`, so the composed bytes go out unchanged rather than HTTPie building a new JSON object from `key=value`. PowerShell emits `Invoke-RestMethod`, not `curl` - on Windows PowerShell `curl` is an alias for that cmdlet, so a snippet saying `curl` runs something else than the reader expects, and a multipart snippet carries a `# requires PowerShell 6.1+ (-Form)` line because 5.1 has no `-Form` at all.

**Quoting is not the end of it: a client can read its own argument as a path.** The bytes survive the shell and the *client* then interprets them, so curl's `-F` uploads a local file for any value starting with `@` or `<`, and HTTPie's item grammar reads `=@` the same way (plus `==` as a query parameter, and a `:` or `@` in a key as a header or a file upload). curl form fields therefore use `--form-string`, which has no such grammar, and HTTPie items escape with a backslash on the key and on a leading separator in the value. `--data-urlencode` encodes only what follows the first `=`, so the field *name* is percent-encoded here and the value is left to curl.

**Secrets are masked by default in resolved output**, revealing is explicit, and masking happens *before* quoting - after it, a value containing a quote no longer matches itself. What is masked: every variable the resolver marks secret, plus the credential the auth mode carries. Jar cookies are never in a snippet (libcurl attaches them at transfer time) and the section says so.

### `Dock` (`components/layout/Dock.tsx`)

Footer bar (h-8, shrink-0). Horizontal layout:

- **Left - drawer switchers:** buttons for Collections (⇧⌘E), History (⇧⌘H), Variables (⇧⌘U), Services (⇧⌘S), Settings (⌘,). Each activates its Drawer view; active state highlights when the drawer is open on that view. Settings sits here too because it is now a Drawer view like the rest.
- **Middle - ambient status:** engine connection status (green dot + text if connected), save status (Saving… / Saved), app version. When the engine is *down* the indicator becomes a focusable tooltip carrying `engineError` - the health poll's reason, which was previously recorded and rendered nowhere, so a refused connection, a timeout and a TLS failure all read as one word. A save *failure* is not shown here - it is reported as a toast, like every other failure in the app.
- **Middle - running services:** a dot plus "2 services" whenever at least one local service (a running webhook inbox, an OAuth issuer) is up, and **nothing at all when none is** - the Dock's middle is ambient, and a standing "0 services" would spend a permanent line on the ordinary case. A **disconnected engine counts as none**, whatever the query cache still holds: services are engine-*process* state, so they died with it, and the gate lives in `useRunningServiceCount` rather than here so no later reader has to re-derive the caveat. Clicking it **reveals** the Services drawer (`revealDrawerView`, never `activateDrawerView`) - an ambient chip pointing at a surface must not be the thing that hides it, and on the toggling call it closed the drawer whenever it was already on Services. Before it, a running inbox was invisible outside its own tab and an issuer was invisible everywhere. → `Dock.services.test.tsx` (mutation-checked: rendered unconditionally, the absent-case tests fail; on `activateDrawerView`, the reveal case fails).
- **Middle - pending restart:** once a setting the engine marks `requiresRestart` has been saved, a "Restart pending" button appears beside the connection status and restarts the engine in place (`useEngineRestart`, shared with the Settings banner so the two cannot diverge). It tracks saves made since this renderer connected - not a comparison against the engine's running values, which it does not report - so it says *saved*, not *in effect*, and does not survive a renderer reload. A failed restart leaves the signal standing and reports the reason as a toast.
- **Right - toggles:** Context bar toggle (⌘I). Pressed when the bar is open *and* the active tab is one it has content for, so the highlight always matches what is on screen.

## Request Builder (`modules/request-builder/`)

The request editor. Entry: `modules/request-builder/index.tsx`.

**Container (`index.tsx`)** - fetches the selected request (`useRequestQuery(selectedRequestId)`), maps the stored `Request` (discriminated-union `body`/`auth`) into flat UI state, and provides callbacks through `RequestBuilderProvider` to `RequestBuilderLayout`. Responsibilities:

- **Execute:** resolves `{{variables}}` in URL/headers/body, injects per-request system headers (`X-Request-ID`, `X-Vayu-Version`), resolves auth, composes scripts, and calls the engine via `useEngine()`.
- **Auth inheritance:** for `auth.mode === "inherit"` it walks the collection ancestor chain **leaf-first** (`useCollectionAncestors`) via the shared `resolveAuthSource`, taking the first collection that defines auth and stopping at one explicitly set to `noauth` (see [variable resolution → auth inheritance](./variable-resolution.md#auth-inheritance)).
- **Script composition:** concatenates ancestor collection pre/post scripts **root→leaf**, then the request's own script.
- **Load test:** opens `LoadTestConfigDialog`, then starts the run (`apiService.startLoadTest` + `loadTestService.startMonitoring`) and navigates to the dashboard.
- **Save:** rebuilds the `RequestBody`/`RequestAuth` unions from flat UI state via `useUpdateRequestMutation`. Sends `name` trimmed, and omits the key entirely when it is blank so a partial update leaves the stored name alone - see [the request name the builder holds is adopted, not captured](./state-management.md#the-request-name-the-builder-holds-is-adopted-not-captured) for why sending it at all took a fix in the provider first.

**Structure:**

| Path | Role |
|---|---|
| `context/RequestBuilderProvider.tsx`, `context/RequestBuilderContext.tsx` | Local request-editing state + the execute/save/load-test callbacks |
| `components/RequestBuilderLayout.tsx` | Resizable vertical layout composing RequestBreadcrumb / UrlBar / RequestTabs / ResponseViewer |
| `components/RequestBreadcrumb.tsx` | One read-only line above the URL bar: the collection chain root-first (`useCollectionAncestors`, cycle-guarded) then the request name, so the builder says which inherited auth, scripts and variables the open request carries. A collection segment opens that collection's tab; the name segment is inert, because renaming is the Info tab's job and a second surface would be two controls for one act. Ancestors get `min-w-0`/`truncate` and the name `shrink-0`, so a deep chain gives way and the name never does. **Renders nothing** - not an empty row - when there is no collection and no name, which is the permanent band `RequestDescription` used to charge every request for one row below |
| `components/UrlBar/` | `index`, `MethodSelector`, `UrlInput`, `SendWithRowMenu`. The method dropdown lives **inside** the URL field's border (one control, not two - it was a separate `w-[76px]` box sized for OPTIONS). Send + Load Test are one **attached** pair on the same accent: Send is `--primary-fill` with a white label, Load Test is `--primary` at 12% with `--primary-text` and a transparent left border, so the join is a step in weight rather than a seam between materials. Send owns both corners when it is alone - `canStartLoadTest` false **and** no row caret. `SendWithRowMenu` is that caret: a split-button on Send that lists the collection's data rows and sends bound to one (issue #601). It is **absent**, not disabled, unless a data contract is in scope *and* `data-file-store` remembers a file for the collection that declared it - and while a stream is open, where Send is Stop. The file is read when the popover opens, never on mount, and the rows are held no longer than the send. Both shortcuts (`⌘↵` / `⌘⇧↵`) come from `constants/shortcuts.ts` and are shown on the buttons. Pasting a curl/wget command into `UrlInput` auto-imports it (see note below) |
| `components/RequestTabs/` | `index` + `panels/`: `InfoPanel` (**first in the row**), `ParamsPanel`, `HeadersPanel`, `BodyPanel`, `AuthPanel`, `AuthInheritBanner`, `script/ScriptPanel`, `InheritedScriptsNotice`, `ChainCard`, `ExamplesPanel`, `SettingsPanel`. `AuthPanel` owns the mode picker (it is the only host that offers `inherit`) and delegates every field group to the shared [`AuthFields`](#shared-auth-fields-componentssharedauthfields), injecting a variable-aware `VariableInput`; OAuth 2.0 reaches [`OAuth2Form`](#shared-oauth-20-form-componentssharedoauth2form) through it. One `ScriptPanel` serves both script tabs, as `variant="pre"` and `variant="post"`; everything that differs between them - the field it binds, the two context keys it reads, the intro sentence and the quick reference - is data in `script/script-variants.tsx`. It replaced `PreScriptPanel` and `TestScriptPanel`, two ~155-line files that a normalised `diff` showed differing in three places. It renders `InheritedScriptsNotice` (the script equivalent of `AuthInheritBanner`) to name which ancestor collections contribute a pre-request or test script; that accepts an optional `entries` prop so a stored-run view can supply parts directly instead of reading the live chain. `AuthInheritBanner` and `InheritedScriptsNotice` share their chrome through `ChainCard` - the tinted box, summary row, captioned list and hairline separators - which they previously wrote out twice, identically. `InfoPanel` holds the request **name** (autosaved: committed trimmed on blur, a blank one refused out loud via `reportBlankNameRefused()` and the stored name restored through the context's `restoreStoredName()`) and its description, and is first because those are the first things you want to read about a request; it replaced `RequestDescription`, a permanent ~30px band above the tab strip that every request paid for whether or not it had one. Its badge is `1` for "there is something here", matching Body/Auth/Scripts/Settings. `ExamplesPanel` lists the request's saved example responses (issues #481, #588): one collapsed row per example with its status chip and name, expanding to the recorded headers and a `ResponseBody` view. Rows can be **removed** but not edited - delete landed with the response viewer's *Save as example* (below) because an example you can create and never remove is the #553 zombie shape at a smaller scale, and it is confirmed through `DeleteConfirmDialog` because a mock server answers with the first example of a matched route. It is not scoped to app-saved rows: the engine's route is not, and telling the two apart here would mean reading an `origin` no surface displays. A row whose `bodyTruncated` is set carries an amber **Partial body** chip beside its name (issue #659) - a mock server answers with the stored bytes as though they were a whole response, and until the engine had the column the fact lived only in the example's *name*, which a rename at save time erased. It keeps three empty-looking states apart (unsaved request, no examples, failed read), because collapsing them is how an unreachable engine reads as "this request documents nothing"; it carries no badge, since the count lives behind a query and a tab row should not wait on the network to finish drawing. `SettingsPanel` holds the per-request execution settings - the **Protocol**, the redirect policy (**Follow redirects** + **Maximum redirects**) and the **Event stream** toggle (issue #574); the tab strip badges it via `isRequestSettingsNonDefault` (in `utils/request-state`) only when the request departs from the engine defaults |
| `components/ResponseViewer/` | `index`, `ResponseCookies`, `ResponseTimingTab`, `TestResults`, `ConsoleOutput`, `RawRequestResponse`, `ClientErrorView`, `SaveAsExampleDialog` + `save-as-example.ts` (status bar, actions and the Headers tab now come from `shared/response-viewer/`). The Console tab renders whenever the response carries console logs **or** a `preScriptError`/`postScriptError`, so a script that throws before logging still shows its error rather than a silent 200. The **Events** tab (issue #574) renders `ResponseEvents`, which now lives in `shared/response-viewer/` because a load run's sampled stream shows the same list - see that section. **Save as example** (issue #588) sits at the right of the tab row rather than beside Copy and Download, which live in the body pane because that is what they act on - this acts on the whole exchange. It is **absent**, not disabled, for an unsaved request (no id to nest an example under, and the Examples tab already says so in a sentence) and while a stream is still open (the placeholder response has no body yet). The payload rules that must not drift live in `save-as-example.ts`, not the dialog: `origin: "user"`, the importers' Content-Type mapping, and never an `order` |
| `components/LoadTestConfigDialog/` | Load-test configuration dialog (mode, duration, RPS, concurrency, …). Renders `OAuth2LoadTestGuard` when the request's effective auth is OAuth 2.0. A second disclosure, **Pass/fail budgets**, declares the run's latency / error-rate / throughput limits; the field table and its rules are `budgets.ts`, and the p99 field is seeded from the `sloThresholdMs` client setting so that setting becomes the default budget rather than a parallel notion of "too slow". A budget out of the engine's range blocks Start with a named message instead of being dropped from the payload |
| `components/OAuth2LoadTestGuard.tsx`, `components/oauth2-load-test-coverage.ts` | Warns when a duration-based load test would outlive its access token (the engine acquires a token once per run, no mid-run refresh): offers **Refresh** when a fresh token would cover the run, or **blocks Start** (with a "Start anyway" override) when even a fresh token can't. The pure coverage decision lives in `oauth2-load-test-coverage.ts` |
| `shared/BulkEditor.tsx` | The table/text toggle above a `KeyValueEditor`, and the textarea it swaps in - `ParamsPanel` and `HeadersPanel` had a copy each. It stayed in the module when the table left for [`components/shared/`](#shared-keyvalue-editor-componentssharedkeyvalueeditor) (issue #567): the shared bucket is what *several* features share, and only these two panels bulk-edit. The formats are the callers' - headers are `Name: value`, params are `key=value` - so a parse, a format and the syntax note are what it takes in |
| `hooks/`, `utils/` | Module hooks - `useHeadersManager`, and `useVariableSupport`, the one adapter from the request-builder context to the `VariableSupport` prop shape (memoised: it is a prop on a `memo`-wrapped row); `utils/key-value`, which is now the single execution-shaped helper `toFlatHeaders` (the row-model half - `toKeyValueItems`, `toKeyValueEntries`, `withTrailingBlank` - moved to the table it describes, see [Shared Key/Value Editor](#shared-keyvalue-editor-componentssharedkeyvalueeditor)); `utils/system-headers`, which owns the three managed headers and puts them in front of that conversion in `toHeaderItems`. Id generation is `lib/id.ts`, since `services/curl/` and the history module already reached across the module boundary for it |

> **cURL / wget import:** pasting a `curl` or `wget` command into the URL field auto-populates the whole request (method, URL, params, headers, body, auth). Auth maps `-u`/`--user` (and wget `--http-user`/`--http-password`) to Basic, and curl `--oauth2-bearer` to Bearer; an `Authorization` header is left as a raw header (to preserve `{{variables}}`). Form-shaped `-d`/`--data` without an explicit `Content-Type` maps to `x-www-form-urlencoded` rows (curl's on-the-wire default), while a raw JSON/text blob stays a text body. Detection + parsing live in `services/curl/` (`tokenize.ts` shell tokenizer + `parseCurl.ts`), kept separate from the collection `importers/` pipeline since this targets the active request. The paste is a request-shape replacement - identity (`id`, `name`, `collectionId`) and scripts are preserved; file references (`-d @file`, `-F field=@file`, `--post-file`) are skipped since they can't be read from pasted text. Non-command pastes fall through to normal input.

> **Body tabs** support `none` / `json` / `text` / `graphql` / `jsonrpc` / `xml` / `form-data` / `x-www-form-urlencoded`. The `jsonrpc` mode is the plain code editor with Monaco's `json` language and an auto-`Content-Type: application/json` - a JSON-RPC call is one JSON document, and the frame around it (`"jsonrpc":"2.0"`, plus an `id` when the call names none) is completed engine-side at the chokepoint every client shares, so there is no structure for this side to edit and no component of its own. It shares the `raw` draft bucket with `json` / `text` for that reason (see [state-management](state-management.md#requestbuildercontext---body-drafts)). The `xml` mode is the same pane with Monaco's `xml` language and an auto-`Content-Type: application/xml`, and shares that bucket too: SOAP and legacy-enterprise APIs are HTTP plus a document the author writes whole, so the mode buys highlighting and the header rather than an editor - the engine sends `content` byte for byte with no envelope, and a hand-typed `application/soap+xml` survives the mode change like any other header the user wrote. The `graphql` mode renders a split resizable editor: a **Query** pane (Monaco `graphql` language with diagnostics, autocomplete, hover, and formatting) and a **Variables** pane (Monaco `json` with schema-derived validation). The Variables pane badges its text when it is not strict JSON - *Templated* for `{{variable}}` tokens, which are resolved and sent, *Not sent* for text the envelope cannot carry - because the two are opposite things on the wire. The editor no longer contradicts the badge: its markers come from a masked twin of the pane (`lib/graphql/variables-diagnostics.ts`), so a token draws no squiggle and everything around it stays validated. Its in-progress text lives in `RequestBuilderProvider` (see [state-management](state-management.md#requestbuildercontext---the-headers-a-setting-added)) for the body drafts' reason: Radix unmounts the inactive tab. **The Variables pane collapses to its own header**, which is the control - the whole bar is the button, since a narrow activator in a wide box is the composite-row hit-area trap. Collapsed, it keeps its badges on screen (a *Not sent* the user cannot see the editor for is exactly when the badge matters) and the query editor takes the height back; `collapsedSize` is the header's own 28px rather than a percentage, so the bar is neither clipped in a short stack nor floating above dead editor in a tall one. The collapse *and* the height to reopen at are in `layout-store` (`graphqlVariablesCollapsed` / `graphqlVariablesSize`, persisted), not component state and not `explorer-store`: the panel's own memory dies with the Radix unmount, and how tall a user wants a pane is a preference like every other one in that store. An insertion that leaves variables needing a value opens the pane on its own - the one moment the badge alone is not enough, because the user now has to type into the editor it names. A document defining more than one named operation also gets an **operation picker** in the Query pane's header, which writes the envelope's `operationName` - the panes carry that field (and any other envelope key) through every edit, so an imported multi-operation request keeps executing the operation it names. Apart from that picker the Query header carries **one** schema control, and only while the explorer is closed: a single chip that is the status badge and the open-the-explorer affordance at once (`panels/body/SchemaStatusBadge.tsx`, sentence in `lib/graphql/schema-status.ts`). It used to carry a badge, a Refresh and a toggle - three controls about a subject whose pane sits beside it, one of them visible at the same time as the explorer's own identical Refresh (#455). The chip does carry a **Refresh of its own, revealed on hover or keyboard focus** and calling the same `refreshSchema` the explorer's does (#507): the rule the consolidation was after is *one standing Refresh*, not one Refresh, and a blind refresh - the endpoint moved, or an `Authorization` was hand-typed, neither of which the cache key can see - otherwise cost opening the pane and closing it again. It is transparent at rest, so no state shows two Refreshes standing, and `focus-visible:opacity-100` keeps it off the list of controls a keyboard reaches while invisible. **Scripts** are two separate panels - pre-request and test - not a single tab.

> **The schema explorer docks beside the query pane** (`panels/body/graphql-explorer/SchemaExplorer.tsx`, opened from the Query header's chip and closed from its own). **Every schema affordance lives in its two-row header**: status and freshness (the same badge the chip wears), the descriptions show/hide, Refresh and the close, over a full-width search box. Two rows because five controls in one left the search - the only one that wants width - competing with the status text for it in a pane that can be 18% of the editor area. It takes the cache's `SchemaEntry` as one prop rather than status, schema and freshness as three, for the reason the body reads it as one: they are four faces of a single state and separately they can render a frame apart. A WAI-ARIA tree over the endpoint's Query / Mutation / Subscription / Types, with argument signatures, inline descriptions, struck-through deprecations and a search that spans the whole schema (`/` focuses it). The search ranks in **three tiers - name, then signature, then description** - and marks the matched run wherever it found it, so a flat result list says why every row is in it. It spans the whole schema literally, enum values and input-object fields included, and inside the name tier the closest match comes first (earliest offset, then shortest name) so the row the user typed is not cut off by the result limit. Descriptions are a tier rather than more haystack because they are prose: folded in with signatures, a common word matches most of the schema through them and drowns the type matches that tier exists to surface. A row matched only through its *signature* stays unmarked, which is the difference showing rather than being hidden; a row matched through its *description* is always drawn in full, because clipped to one line the description is usually cut off before the word that put the row in the results. Descriptions are otherwise clipped to one line, with a **show/hide in the pane header** (remembered per schema in `explorer-store`) for reading them in full - one pane-level control rather than a per-row disclosure, since a third target inside a 24px row is the composite-row hit-area trap `drawer-row-hit-area` was written against. It is *beside the editor rather than in the context bar* because the bar clamps to 220-480px and because insertion wants to be next to the cursor it inserts at - the bar gets the status half instead (`GraphQLSection`, above). Rows are windowed with `useGrowingWindow`, not a virtualisation library, and keyboard navigation reuses `useRovingTreeFocus` rather than a second copy of the treeview pattern. Activating a row calls `insert-skeleton.ts`; the resulting query **and** variables are written in one `serializeGraphQLBody` call, since two writes would each re-serialise the envelope and the second would undo the first. The caret is placed in an effect keyed on the new query, because the pane is `value`-controlled and Monaco's model still holds the old text at the moment of the click. Activating a row whose leaf the selection set **already holds** writes nothing: the existing line is selected and revealed instead, and the live region says it is already selected. Duplicate fields are valid GraphQL - they merge - so this is not the never-produce-an-invalid-document contract but the second click adding a line the user cannot tell from the first; the narrowing is deliberate, since a field with required arguments can honestly repeat and an object field's second copy brings its own selection. Every insertion, every already-there, and every refusal (a subscription, an enum value, a type with no compatible cursor), reaches a polite live region - the same mounted-empty pattern as `ResponseAnnouncer`. The explorer performs **no introspection of its own**: it renders the schema cache, and its Refresh is the only *standing* one - the Query header's second copy is gone, and the chip's (above) appears only on hover or focus while this pane is closed.

> **The Event stream toggle, the Events tab and the Stop button** (issue #574). Turning on **Event stream** in the Settings tab makes Send consume a `text/event-stream` endpoint live: `POST /execute` answers `202 {runId, eventsUrl}` at once and the upstream's events arrive over `GET /runs/:id/events`. It is a *setting*, not a `BodyMode` - the request's body semantics are untouched, and a stream is a GET as often as it is a POST - and it is stored on the request (`requests.stream`), because it describes the endpoint rather than one send. Turning it on arms `Accept: text/event-stream` through the same reversible-side-effect rule the body mode's `Content-Type` uses, extracted to `utils/auto-header.ts` so there is one copy of it (see the GraphQL note below for the rule itself). While a stream is open the URL bar's **Send becomes Stop** (`POST /runs/:id/stop`) and the status band reads *Streaming - N events*; the eighth, always-rendered **Events** tab shows the rows. Live rows come from `stores/execution-events-store` via `hooks/useExecutionEvents` - a per-endpoint `EventSource` with its own reconnect and `?lastEventId=` resume, the `useInboxLive` shape rather than the `SSEClient` singleton, which belongs to load and scenario runs and deliberately never reconnects. When the stream ends the provider fetches the run's report and `restore-response.ts` swaps in the stored `events` node, which is the record and the only copy carrying the truthful `totalEvents` / `eventsTruncated` markers - the same two-sources-one-list handoff `ScenarioRunView` makes. Every termination names itself (`completed`, `stopped`, `maxStreamEvents`, `maxStreamDurationMs`, `idleTimeout`, `error`) and every cap is disclosed in band. A streaming design run does **not** block a load test and is not blocked by one: they are independent surfaces. Scripts run on a streaming send (issue #575), split around the transfer - Pre-request before the stream opens, Tests once it has terminated, reading the retained events as `pm.response.events` - and the Settings panel says *when* rather than warning that they are refused, because Send has returned long before the results reach the Tests and Console panes.

> **Choosing GraphQL writes a header, and leaving GraphQL removes it.** GraphQL is sent as a JSON envelope, so picking it appends `Content-Type: application/json` to the Headers tab (unless an enabled `Content-Type` is already there) and says so in a notice with an Undo. The next mode change that no longer needs that header takes the row back out. The row is tracked **by id** - a `Content-Type` the user typed is indistinguishable by value and always survives, as does one whose value has since been edited. The rule itself lives in `utils/auto-header.ts` (`switchAutoHeader`), because the Event stream toggle needs the identical one for `Accept` and a hand-rolled copy of a primitive does not receive the primitive's fixes; `panels/body/content-type.ts` is what maps a body mode to the value it requires and is shared, not panel-private: the collection importers ask the same `contentTypeToAdd` question at import time (see [import-collections](import-collections/postman.md)), because an imported GraphQL request never passes through the mode picker and used to reach the wire with libcurl's default `application/x-www-form-urlencoded`. The record lives in `RequestBuilderProvider` (see [state-management](state-management.md#requestbuildercontext---the-headers-a-setting-added)) because the panel is unmounted whenever another tab is on screen.

## GraphQL Library (`lib/graphql/`)

Shared, Monaco-independent modules that power the GraphQL body mode.

| File | Role |
|---|---|
| `graphql-body.ts` | The GraphQL-over-HTTP envelope, converted to and from the two editor panes. Keeps `operationName` and any key it does not model (`extensions`) across a round trip - the pair used to carry `{query, variables}` alone, so one keystroke deleted the rest. Variables that hold `{{tokens}}` outside a string are written into the envelope verbatim (the engine resolves them before sending); variables that are broken for any other reason are still dropped, and `classifyVariables` is what the pane's badge reads to tell the two apart. A string-typed `variables` (Postman's shape) shows verbatim rather than JSON-encoded. Also `operationNames` (which operations a document defines, for the picker), `documentOutline` (kind, name **and** starting line of every operation, anonymous ones included, for the context bar's outline - `operationNames` drops all three, since it answers the narrower "what may be sent as `operationName`"), `findOperationLine` (where an outline row's operation sits in *another copy* of the document - the bar reads the stored request and the editor holds the live buffer, so a row is resolved by name rather than by carrying its line across) and `toGraphQLEnvelope` (wrap a bare query document, used by the Insomnia importer). |
| `diagnostics.ts` | Pure (Monaco-free) diagnostic computation - syntax check via `graphql.parse` when no schema is available; full field/type validation via `graphql-language-service.getDiagnostics` when a schema is loaded. Returns 1-based `GqlMarker[]` matching Monaco's `IMarkerData` shape. `{{variable}}` tokens are masked before the pass and any marker landing on one is dropped, so the editor no longer flags an idiom the engine supports - and, because an unmasked token is a *parse* failure, the rest of the document stays validated. |
| `templates.ts` | The three maskings `{{variable}}` tokens need, split by whether the caller needs the *positions* back or the *token text* back. For GraphQL text, a length-preserving swap to a Name plus the spans, so marker positions stay usable against the original. For JSON text on the wire path, a string-aware swap to a sentinel string (tokens already inside a JSON string are left alone), so a templated variables object parses and can be written back verbatim. For JSON text being diagnosed, the same string-aware scan swapping each token for a JSON string of its exact length, plus the spans - never unmasked, which is why it can use a placeholder a user could also have typed. |
| `format.ts` | Format Document for GraphQL, via prettier's graphql parser loaded on demand. It was `print(parse(text))`, which has nowhere to hang a `#` comment and deleted every one of them; returns null on unparseable input so the caller pushes no edit. |
| `introspect.ts` | Fetches a `GraphQLSchema` by routing the standard introspection query through the engine, avoiding CORS. Composes first (`apiService.composeRequest`, `POST /compose`) so the endpoint's `{{variables}}` and its **Auth panel** config - `inherit` walked through the collection chain, OAuth 2.0 included - are resolved engine-side, then overlays the introspection query onto the composed payload and sends it with `apiService.executeRequest`. It holds no resolution logic of its own; the composed body and script parts are dropped, since introspection is not sending the user's request. The execute payload carries `transient: true` and the target's `environmentId` (issue #382), so the fetch leaves no run row, trace or History entry behind and still reads the environment's cookie jar. |
| `schema-cache.ts` | Zustand store (`useSchemaCache`) keyed by `schemaCacheKey(target)` - resolved endpoint URL **plus** the credentials it is reached with (collection scope, environment, auth block), because introspection now sends auth and two environments can point one URL at different credentials. Headers are deliberately out of the key (they are edited keystroke by keystroke); a hand-typed `Authorization` needs the Refresh button. Callers hand over a `SchemaTarget` and never build the key. States: `idle → loading → ready \| error`. `ensureSchema` skips targets already attempted; `refreshSchema` forces a re-fetch. Exposes `getActiveSchema()` and `getActiveStatus()` for Monaco providers, and `activeTarget` - the target the active key was derived from - so a surface outside the request builder (the context bar's GraphQL section) can call `refreshSchema` without rebuilding the resolved URL and auth a second time. |
| `schema-status.ts` | The one sentence about the schema in hand, derived from a `SchemaEntry` alone - the per-kind failure hint (#383) plus freshness. Pure and Monaco-free, beside the store it reads, because two surfaces render it: the explorer header's badge and the Query pane's chip. A second copy in either is how the two came to describe one subject in different words from different panes (#455). |
| `language-providers.ts` | Registers Monaco language providers for the `graphql` language: completion (fields, types, directives, each carrying the kind the language service classified it as), hover type info, debounced inline diagnostics (re-runs on content change and on schema cache updates), and document formatting (`format.ts`). Completion triggers on structural characters only - never space or newline, which popped the widget so the next Enter accepted a suggestion instead of breaking the line. Call once after `loader.config`. |
| `schema-tree.ts` | The explorer's tree model and its search index. Children are computed **on demand** per expanded row rather than built into a tree up front - a schema is a graph (`User.posts` → `Post.author` → `User`), so materialising it either recurses forever or prunes branches on the user's behalf. A field row carries the `rootPath` it was reached by (`[Query.user, User.posts, Post.title]`), which is the one thing insertion cannot recover on its own; rows browsed under the Types branch have no path and say so with a null. The search index *is* materialised - one pass over the type map, no traversal - because a search has to see rows nobody expanded, and it covers **every kind `childNodes` can produce**, enum values and input-object fields included: a row browsable one click later must not answer "Nothing matches". Both of those carry a null `rootPath` like a Types-branch row, so insertion refuses them by kind rather than guessing a route. Each entry keeps its name, signature and description lowercased separately rather than as one haystack, because the ranking turns on *which* of them matched; a match reports its offset in the name **and** in the description, and `splitAtMatch` cuts either into the three segments the row draws. **Within the name tier the closest match wins** - earliest offset, then shortest name, so an exact match needs no special case - and the whole index is scanned before the `limit` (200) cuts, because a better match than the first 200 is routinely declared after them: in declaration order, a schema of 60 `POST_*` enums ahead of its `Post` type returned 200 leaf rows and neither the type nor `Query.post`. The index arithmetic stays here, out of the component, so it is testable without a DOM. |
| `insert-skeleton.ts` | Turns an explorer row into an edit of the query document, under one contract: **the document still parses afterwards**. A field lands in the cursor's selection set only when that set's type owns it (no inline-fragment guessing on an interface or union), then in an enclosing set, then as a new named operation; a path-less row with nowhere to go is *refused out loud* rather than guessed at. Required arguments become `$variables` **and are declared on the operation that gains them** - including promoting a shorthand `{ … }` operation to `query ( … )`, which otherwise cannot carry any. Also `mergeVariables`, which folds new variables into the Variables pane only when its text is strict JSON: merge, never replace, and never touch a `{{token}}` draft - what it could not write comes back as `pending` for the badge to name. |
| `explorer-store.ts` | Zustand store for the explorer's view: whether the pane is open, and per schema identity (the same `schemaCacheKey`) the search text, the expanded row ids, the scroll position and whether rows show their full description. A store rather than component state because Radix unmounts the whole Body tab on a glance at Headers - the body drafts learned this the hard way. In memory only, capped at `EXPLORER_VIEW_MAX_ENTRIES` (8, matching the schema cache): an expansion set describes a schema that may not exist next launch. |
| `reveal-store.ts` | One slot: the operation the context bar's outline asked the query editor to scroll to. The outline sits outside `RequestBuilderProvider` and the Monaco instance stays private to `GraphQLBody`, so what crosses the boundary is a request to reveal rather than the editor itself. Consume-and-clear, the same shape as the insertion effect and for the same reason - a command left in the slot is replayed on the next remount, which the Body tab does on every glance at Headers. Cleared by whoever decides its fate: `GraphQLBody` after revealing (or after failing to find the operation), the provider for a command naming another request or one whose body is no longer GraphQL. |
| `variables-schema.ts` | Derives a JSON Schema from the query's `$variable` definitions + the introspected schema via `getVariablesJSONSchema`, then applies it to the variables editor through `monaco.json.jsonDefaults` so variable values are validated and autocompleted. The query is masked before it is parsed - one `{{token}}` anywhere used to cost the pane the schema for every variable the query declares - and the schema is registered against the pane's masked twin as well as the pane itself. |
| `variables-diagnostics.ts` | What the Variables pane's JSON markers are computed from: a hidden twin model holding the pane's text with every out-of-string token masked to a same-length JSON string. Monaco's JSON worker validates the twin, and its markers are republished on the visible model minus the ones that land on a token - so a `{{token}}` no longer reads as a syntax error while a genuine mistake beside it, which the aborted parse used to swallow, now does. Filtering the worker's markers on the pane itself cannot do this: one token also earns an `End of file expected.` on the character *after* it. |

`lib/monaco-setup.ts` (sibling of `lib/graphql/`) configures `@monaco-editor/react` to use the locally bundled `monaco-editor` instead of the jsDelivr CDN, wires language web workers via Vite `?worker` imports, and calls `registerGraphqlProviders`. It is a side-effecting module imported once at the top of `main.tsx`.

## Collections (`modules/collections/`)

| Component | Role |
|---|---|
| `CollectionTree.tsx` | Hierarchical tree of collections + requests in the sidebar; expandable folders, context menus, method badges. Layout and the panel chrome only - the reveal effects, the CRUD state and the shared row values each live in their own module below. State from `useCollectionsStore` + `useCollectionsQuery`/`useRequestsQuery` |
| `context/CollectionTreeContext.tsx` | Everything a row needs that is not the row itself: the expanded set, the selection, the rename/delete state and every handler. `CollectionItem` renders itself recursively, so a threaded prop had to be re-listed at four sites and thirty of its thirty-three props were the same object at every depth. Rows read it through `useCollectionTreeContext()`, which throws when a row is rendered without the provider. Carries the `dnd` slice `useTreeDnd` mounts - `null` where no drag machinery is mounted, which is what a test rendering one row gets |
| `useRevealActiveSelection.ts` | The two once-per-selection effects that keep the active tab's row rendered and on screen: expand its ancestors, then scroll it into view. Separate refs, because the scroll can only run a render after the reveal. Also returns `revealEntity`, the imperative version a move calls: a move does not change the selection, so nothing in those effects would fire |
| `useTreeDnd.ts` | The drag machinery: pointer capture, hit testing, spring-loaded folders, auto-scroll, Alt+Arrow moves, the "Move to..." dialog state and the undo offer. Everything decidable without a DOM is delegated (`drag-gesture.ts`, `drop-position.ts`, `reorder-math.ts`, `useReorderMutation`), and all four ways a row can move go through one `applyPlacement` so the write, the announcement and the reveal cannot drift |
| `tree-row-dnd.ts` / `TreeRowDnd.tsx` | The per-row half, shared by both row types: `useRowDnd` (handlers, drag/blocked/indicator state, the "Move to..." action), `rowDndClasses`, the 2px `--primary` drop line indented to the target's depth, and the four hidden `data-tree-move-*` Alt+Arrow controls |
| `MoveToDialog.tsx` | The row menu's "Move to...": a tree-ordered picker of every collection the row may move into, minus itself, its own subtree and the parent it already has. The chord-free path to the same move |
| `useTreeCrud.ts` | Create, rename, duplicate and delete for the tree, with the inline form state each drives. Returns `panel` (what the tree's own chrome renders) and `rows` (the slice the context hands every row) |
| `CollectionItem.tsx` | A collection (folder) row. Props are its entity, depth and position in the sibling set; everything else comes from the context |
| `RequestItem.tsx` | A request row (method badge, click → open in RequestBuilder, context menu). Same prop rule as `CollectionItem` |
| `ImportModal.tsx` | Import collections from file/URL/paste (Postman / Insomnia / OpenAPI). Mounted globally in `Shell`; open-state in a dedicated store. Entry is per **file**: a multi-file drop or selection, or "Import folder" (`webkitdirectory`, recursed and filtered to `.json/.yaml/.yml`), previews as a **batch ledger** - one row per picked file with its detected format, counts, skip tally or error, and an include checkbox - and applies each file as its own `POST /import/apply`, so one refused file does not undo the others. One file renders the full preview tree instead; a file another picked document inlined as a `$ref` target is listed as such and never imported twice. See [import-collections/](./import-collections/README.md) for the batch layer and the parser pipeline |
| `tree-utils.ts` | Every `parentId` walk in the renderer: `walkAncestors` (the ancestor chain, root first), `isDescendant`, `collectDescendantEntityIds` (what a cascade delete reaches). Each carries a visited-set termination guard - the engine tolerates cycles in stored data, and an unguarded walk hangs the window rather than answering wrongly. Also used by `queries/collections.ts` and `useVariableResolver` |
| `drag-gesture.ts` | Press versus drag, and the trailing click. A pure state machine over pointer coordinates: below the ~4px threshold a press is still a click (the row opens synchronously, which the hit-area guards pin), and a completed drag swallows exactly one following click - the one that would otherwise open the row that was just dropped |
| `drop-position.ts` | Where a drop lands: 25/50/25 bands on a folder row, 50/50 on a request row, resolved against the folders-first two-block rule. A request "between two folders" cannot sit there, so it resolves to the head of that parent's requests; a folder over a request row is refused outright. Returns a block + anchor, never a pixel position |
| `reorder-math.ts` | The arithmetic behind a drop: `planCollectionMove` / `planRequestMove` turn sibling lists and a target index into the `POST /reorder` batch, writing only the rows whose position changes and normalizing a scope whose rows all predate explicit orders. Pure and node-tested - the part of a drag a jsdom gesture cannot reach. Consumed by `useReorderMutation` |
| `CollectionDetail/` | The collection editor screen (see below) |

### `CollectionDetail/` (screen `"collection-detail"`)

Tab shell reached via `navigationStore.navigateToCollection(id)`. Header shows name + request count, and - right-aligned - the mock-server control; seven tabs:

| Tab | Component | Notes |
|---|---|---|
| Info | `InfoTab.tsx` | Name, description, request count. **Autosaves** - no Save/Cancel |
| Auth | `AuthTab.tsx` | Collection-level auth (concrete; never `inherit`). Mode picker + hints only - the fields are the shared [`AuthFields`](#shared-auth-fields-componentssharedauthfields). **The one tab with a Save button**, and it says so above the fields |
| Pre-request | `ScriptTab.tsx` (`kind="pre"`) | Collection pre-request script. **Autosaves** on editor blur - no Save |
| Post-request | `ScriptTab.tsx` (`kind="post"`) | Collection post-request script. **Autosaves** on editor blur - no Save |
| Variables | `VariablesTab.tsx` | Collection-scoped variables (count badge) |
| Data | `DataTab.tsx` | The declared **data contract** (issue #599): pick a file, preview it, **Declare** its columns onto `collection.dataSchema`, **Clear** to reset, plus the **referenced-columns audit** (`ColumnAudit.tsx`, issue #600). Declared-column count badge. Saves explicitly per action, so it holds no draft and is absent from `TABS_HOLDING_DRAFTS` |
| Spec | `SpecTab.tsx` | The bound **OpenAPI document** (issue #638): where it came from, its short hash, when it was fetched and bound, and how many of the subtree's requests carry an operation identity. Binds a collection that was not imported from a spec - match by method and path shape, counts disclosed, matches stamped and nothing else touched - **Unbind** sends `openapi: null`, and **Export as OpenAPI** opens the export dialog (issue #630). The **Sync** section (`SpecSync.tsx`, issues #654 and #655) re-reads the document from the URL or file the binding recorded, reports what moved in three buckets, and applies the items the user ticks in one engine call - checking still writes nothing, and a removal is never ticked for you. Explicit per action, so it is absent from `TABS_HOLDING_DRAFTS` like Data |

`MockServerControl.tsx` is the header's right-hand control and the only surface that can **start** a
mock server (issue #481 phase 2), because it is the only one holding a collection. With none running
for this collection it is a **Run mock server** button; with one running it is a chip carrying the
base URL, the route count and how many of those routes have no example, plus copy and stop. It picks
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
The mutation stays in `MockServerControl` and the dialog reports its failure as a `Callout` instead
of a toast behind an open form; opening the dialog resets it, so a failed one-click start does not
greet the next open. Neither knob is mutable on a running mock: they are read per response and so
*could* be, but a run against a mock has to be able to say which configuration produced its numbers
- the same reason the route table is frozen - so there is no `PUT /mock/:id` and the stop tooltip
names all three as start-time.

`InheritanceChain.tsx` and `shared.tsx` are helpers used by these tabs (e.g. visualizing the auth/variable inheritance chain); `format.ts` holds the relative-timestamp helper, kept out of `shared.tsx` so a file of components exports nothing else (fast refresh).

All five tabs hold their edits in a draft; four of them commit it without being asked. Info commits on blur (name) and on `onCommit` (description); both Script tabs commit when focus leaves the editor; Variables autosaves through `VariableTableEditor`. Info and the Script tabs take the draft, the resync and the mutation reset from [`useEntityDraft()`](./state-management.md#useentitydraft---manual-draftsave-model) and render no Save button at all - the hook owns the mutation reset on a collection switch, which had been hand-rolled per tab with one tab omitting it.

Info's blank-name rule survives the buttons' removal by being spoken instead: `reportBlankNameRefused()` (`lib/blank-name.ts`) puts the stored name back and reports through `failSave`, the same channel and the same wording the request builder's Info tab uses. The Script tabs' `Clear` writes on the press rather than waiting for a blur that is not coming - focus lands on the button, not in the editor.

**Auth is the exception, and it is a decision (#446), not a leftover.** Not because a credential outranks a script - the request builder autosaves its own auth - but because a blur inside `AuthFields` is not a completion signal. Measured on this tab: an OAuth 2.0 config with Advanced open renders 20 focus stops, 9 of them non-value controls (the grant-type and Add-to pickers, three switches, the secret reveal toggle, the Advanced disclosure, Get Token), and clicking reveal to check a half-typed password fires `focusout` while the draft is dirty. The fields only make sense written together, which is what the button means. A script tab has exactly one focus stop. Because the tab therefore differs from its neighbours, it states its save model above the fields rather than only through a button further down the page. If collection auth is ever to persist by itself, the mechanism is `useSaveManager`'s debounce, not a blur.

## Load Test Dashboard (`modules/dashboard/`)

Live load-test metrics. Entry: `modules/dashboard/index.tsx`.

Connects to the engine SSE metrics stream (`/runs/:runId/live`, via the load-test service / dashboard store), shows live metrics while running, and converges on the final report on completion. Stop action supported.

The dashboard is **mode-adaptive**: a `useMode()` discriminator maps the run config to one of `constant_rps` / `constant_concurrency` / `iterations` / `ramp_up`, and the hero row + stat row + charts render the surfaces appropriate to that mode. `MetricsView` is a thin orchestrator over a modular tree:

**Top-level (`components/`)**

| Component | Role |
|---|---|
| `DashboardHeader.tsx` | Title, run status, stop button |
| `RunMetadata.tsx` | Endpoint, config (mode/duration/RPS/concurrency), timing |
| `MetricsView.tsx` | Orchestrator - composes the hero row, stat row, and charts per mode |
| `RequestResponseView.tsx` | Status-code distribution, error breakdown, timing breakdown, sampled requests. An expanded validation-failure sample lists each failing test's `trace.failures` message, not just the `ERR` chip and pass/fail counts |
| `shared.tsx`, `tooltips.tsx`, `format.ts` | Shared bits (Eyebrow/InfoChip) + centralized InfoChip wording + the `fmt()` number formatter (its own module so `shared.tsx` exports only components) |

**`hero/` - mode-adaptive hero cards** (`HeroRow.tsx` selects per mode, all built on `HeroCardShell.tsx`): `RateFidelityCard`, `DroppedRequestsCard`, `AchievedThroughputCard`, `ThroughputCard`, `ThroughputTwinCard`, `CurrentConcurrencyCard`, `ConcurrencyUtilCard`, `SaturationCard`, `ProgressCard`, `ErrorRateCard`.

**`charts/`** - all time-series, scatter, and distribution plots are centralized in **`charts/uplot/`** and built on a single Canvas primitive, `UPlotChart.tsx` (uPlot). Import them from `charts/uplot/index.ts` so live and history render identical components: `LatencyPercentilesChart` (p50/p95/p99), `LatencyBreakdownChart` (wire/queue-wait split), `RequestRateChart` (configured-vs-achieved throughput), `ConnectionsChart`, `ErrorRateChart`, `ServerVitalsChart` (scraped server metrics joined onto the run timeline) (from `TimeSeriesCharts.tsx`); `ResponseTimeVsConcurrencyChart` (ramp_up capacity discovery w/ breakpoint marker) and `HdrPercentileChart` (from `ScatterAndDistribution.tsx`); and `StatusCodesOverTimeChart` (stacked). Supporting modules in the same folder: `buildData.ts` (series → uPlot data), `chartFocus.ts` + `syncKeys.ts` (scatter↔time cross-highlight/cursor sync), `plugins.ts`, `formatters.ts`, and `uplotTheme.ts` (CSS-token-driven theming). `plugins.ts` carries the two overlay layers `UPlotChart` registers for every chart: `markersPlugin` pins a single value (`Marker` - the capacity breakpoint, the target RPS, the SLO) and `annotationsPlugin` shades a span (`Annotation` - the detected anomaly windows, drawn under the markers so a dashed rule stays legible over a band). The time-series wrappers take the domain shapes (`breakpoint`, `anomalies`) and map them onto those chart-layer ones, so a caller never assembles a marker or a band by hand. Outside `uplot/`, `HdrPercentilePlot.tsx` is now just the loading skeleton (`SkeletonHdrPlot`), `TimingWaterfall.tsx` remains an SVG chart, and two plain-DOM readouts sit beside it inside the same card: `PhasePercentiles.tsx` (per-phase percentiles over every completion) and `StreamMetrics.tsx` (issue #576 - what a streaming run's transfers delivered: events/sec, the per-completion event distribution, and how many streams a cap ended rather than the server). Both render `null` when their report section is absent, which is every non-streaming run for the second - the engine omits the section rather than zeroing it, so a card claiming an event rate of zero is a state the dashboard cannot reach.

**`stats/`** - `ModeStatsRow.tsx` routes to the per-mode Row 4 stat set; `ModeStatCards.tsx`, `StatCard.tsx`.

**`hooks/`** - `useMode.ts` (run-config → mode discriminator).

**`utils/`** - `metricsTransforms.ts` (SSE history → chart series), `reportToDerived.ts` (stored `RunReport` → the same `DashboardDerived` shape, so history reuses the live components), `computeBreakpoint.ts`, `detectAnomalies.ts`, `computeEta.ts`, `chartGeometry.ts`. `types.ts` holds the shared dashboard types (`DashboardDerived`, etc.).

`detectAnomalies.ts` is the run's degradation windows - latency spikes, error bursts, throughput drops and the first 5xx - scanned out of the same per-tick series the charts plot, with fixed factors over a trailing median and nothing tunable. It is derived once per view (`MetricsView` live, `LoadTestDetail` for a stored run) and passed down, so no card or chart re-derives it. Two readings of one detection: the charts shade the windows, and the history Overview's `RunEvents` card states them in words. Both are absent for a clean run.

## History (`modules/history/`)

Past runs (single executions and load tests), split into a sidebar list and a main detail view.

**Sidebar (`sidebar/`):** `HistoryList.tsx` (filter/sort all runs; state from `useHistoryStore`, data from `useRunsQuery`) and `RunItem.tsx` (one run row - method badge, status, relative time, URL, load-test chips).

The filter row also carries a **Pinned** toggle, and it is the only filter that changes what is *fetched* rather than what is shown: it drives `GET /runs?baseline=true` (see `useRunsQuery`), so a baseline pinned long enough ago to sit past the loaded pages is still findable - which is the whole point of a filter for pins. It is applied a second time client-side, because unpinning patches the loaded pages in place instead of refetching them; without that pass the row just unpinned would linger in the pinned-only list until the next poll.

A **load run's** row also carries the baseline pin: a Pin action beside Delete (`useSetRunBaselineMutation` → `PUT /runs/:id/baseline`) and, once pinned, a "Baseline" chip that stays visible rather than appearing on hover - the pin is state, not an affordance. Only load runs offer it: a baseline exists to be diffed, and only a load run has percentiles, throughput and an error rate to diff. Pinning also exempts the run from the engine's retention, so the promise is worth making only where it buys something. No confirmation dialog, unlike Delete - both directions are one click from being undone.

A **collection run's** row is a different shape, because it has no url and no method: a folder icon and the collection's name, over a chip line of step count, iterations (omitted when 1, the default) and sub-folders. The badge slot beside Delete is deliberately **empty** for one. That slot marks the types whose identity line would otherwise look alike - load and design both print a bare URL, so load carries the ⚡ - and a collection run's identity is already unmistakable, so a badge there would be the third glyph in one card saying the same thing, after the folder icon and the step count. Guarded by a test asserting no two icons in the card are the same glyph.

A **collection run** row has no url and no method - its work is a sequence - so it renders `summary.scenario` (`GET /runs`) instead: the collection's name, the plan's step count, and iterations when there was more than one pass. The name is not on the wire; `HistoryList` resolves it from the loaded tree with one shared `useCollectionsQuery` and passes it down, so the row stays presentational over already-shaped data and the page does not become one query per row. A collection deleted since its run falls back to the id it does have. The type filter carries all three run types - `filterRuns` compares its value to `run.type` directly, so a type the dropdown cannot name is one the list can only show under "All".

**Detail (`main/`):** `HistoryDetail.tsx` routes by run type to `DesignRunView.tsx` (a single request execution, opened as an editable copy), `ScenarioRunView.tsx` (a collection run's step list) or `LoadTestDetail.tsx` (load-test report).

`HistoryDetail` fetches the **run** (`useRunQuery`) and asks for the report only when the run is a load run. `GET /runs/:id/report` is a load-test aggregate: against a design run its percentiles all come from one sample and `metadata.configuration` is absent, so it cannot say what a design run's auth, scripts or redirect settings were. `GET /runs/:id` can, and for a design run it also carries the stored exchange. The header shows the run's identity, type and status but **not** its URL - the builder below renders its own URL bar, and two stacked read as a bug. A **scenario** run is not gated on its report either, for a different reason: while the sequence is still executing the live `step` stream is the content, so waiting for a report that does not yet describe a finished run would hold the tab on a skeleton for the length of the run. `ScenarioRunView` asks for the report itself.

`DesignRunView.tsx` renders `RequestBuilderProvider` + `RequestBuilderLayout` with starting values from `design-run-seed.ts` (`seedFromRun`), the stored exchange as `initialResponse`, and the run's recorded collection script parts as `inheritedPreScripts` / `inheritedPostScripts`. It **holds the pane until `useRequestQuery` settles**, and tells a genuine deletion from a transport failure before seeding: `seedFromRun` reads a falsy live request as "deleted", so a query in flight, a deletion and an unreachable engine all look alike unless kept apart. The provider re-seeds only on a change of `initialRequest.id` - null for every detached copy - so an early or wrong seed would stick. Loading holds the pane; a genuine deletion (the `RequestNotFoundError` sentinel from `useRequestQuery`, matched via `isRequestNotFound` not a message string) seeds the orphan copy that replays the recorded wire headers; any other settled error is a transport failure and renders `ErrorState` with a retry rather than guessing a copy. The run's recorded auth **mode** (`seed.recordedAuthMode`, all that survives storage) is shown read-only beside the copy, so a user can see when the request's current auth differs from what the run sent. A run recorded before script parts existed passes its one glued string as `legacyPreScript` / `legacyPostScript`; `LegacyScriptNotice` shows it whole with a note that its parts cannot be separated, and the replay sends it as a single request-origin part. **The copy is detached** by two independent gates - `id: null` and no `onSave` - so editing it cannot rewrite the saved request. Sending again replays the recorded collection parts unchanged plus the edited request part, under the same `requestId`. `SaveRunToRequestDialog.tsx` + `save-run-to-request.ts` write chosen values back behind a confirm; they never write auth (only the mode survives storage) and never write scripts for a run stored before script parts existed.

`LoadTestDetail.tsx`'s header carries `components/BaselineComparison.tsx`, the **vs-baseline strip**: the open run's p99, throughput and error rate against the run pinned for the same request, each delta coloured by `MetricDelta.direction` rather than by its sign (latency up is a regression, throughput up is not). It resolves the pin itself (`useBaselineRunQuery`: by `requestId`, or by url+method for a run of an unsaved request) and fetches the run row from the shared cache the pane above already filled, so it stays self-contained instead of threading a prop through every call site. It renders **nothing** when no run is pinned, when the open run *is* the pin, or before the baseline's report has loaded - a strip of zeros would claim "nothing changed" about runs that were never compared. The diff comes from `lib/run-compare.ts`, mirrored by the MCP tool's `electron/mcp/compare.ts` and pinned to it by `compare.conformance.test.ts`. Three metrics, **by design and not by omission**: the diff also computes p50/p90/p95/avg/max and the status-code merge, but this is a one-line glance in a report header, and the run's own percentile charts and status-code table sit just below it in the same view (an agent that wants every delta has `compare_runs`).

`ScenarioRunView.tsx` is the collection-run tab: the sequence, step by step, plus a four-number summary. It is deliberately **not** `LoadTestDetail` - a scenario run's `results[]` are step executions of *different* requests, so the load report's percentiles and status distribution would describe a sequence as though it were one request repeated.

Its list has two sources and `scenario-steps.ts` collapses both to one `ScenarioStepRow`:

| Source | Carries | When |
|---|---|---|
| `step` SSE events (`services/sse-client.ts` → `scenario-run-service.ts` → `stores/scenario-run-store.ts`) | Identity, outcome, status code, latency. **No exchange.** | While the run streams |
| `RunReport.results[]`, each with the step identity the engine stamps onto its trace | The stored design-mode trace, so the row expands into a response | Once the run is over |

Stored rows win the moment there are any, which is also what makes a re-opened tab honest: a completed run has no live steps and reads entirely from storage. `ScenarioRunService` refetches the report on `complete`, which is the changeover.

Three rules the list holds, each pinned by a mutation-checked test:

- **Rows key on `(iteration, stepIndex)`, never arrival order.** The SSE ring replays from `Last-Event-ID` on reconnect, so a client that resumed mid-run receives events it has already rendered; appending would double every row it re-saw. A malformed `step` payload is dropped by `parseStepEvent` rather than defaulted, because a defaulted `0:0` would *collide* with the real first step.
- **`skipped` is never `passed`.** It has its own count and its own row treatment (`SampledExchange`'s `state` prop, below). Nothing produces `skipped` until flow control lands, so it is built to render correctly before it can occur.
- **Thinned results say so.** A run that filled `maxScenarioStoredSteps` reports fewer rows than it ran, with every non-passing step among the ones kept - so a non-zero `stepsDropped` means *successes* are missing. `ScenarioRunView` discloses the three numbers rather than letting `results[]` read as the whole run.

A live run can be **stopped** from this tab (`StopRunButton`, below), which matters most for a data-driven run of hundreds of iterations. The control is shown while `isStreaming || run.status is running|pending` - two signals rather than one, because a tab reopened onto a run that is still executing (after a relaunch, or from History) has no stream at all, and is exactly the case where waiting the run out hurts most. It calls `POST /runs/:id/stop`, which needs nothing new engine-side: the scenario runner already checks `should_stop` per *step*, settles the run to `Stopped` and closes the SSE topic, so the streaming tab flips to the stored rows through the same `complete` a normal finish takes. The handler also invalidates the run and its report itself, because a tab that is not the streaming one never receives that event.

`components/ScenarioStepCard.tsx` renders one step on the shared `SampledExchange`, restoring the response through `restore-response.ts` - the same path a design run's response pane uses, not a second reading of `trace_data`. `SampledExchange` gained an optional `state` (`success | error | slow | skipped`) and a `title` slot for this: its state is otherwise derived from the status code, which would read a `failed` assertion over a `200` as a success and a `skipped` step as a connection failure.

The entry point is `modules/collections/RunCollectionDialog.tsx`, opened from a collection row's ⋯ menu. Four options - Recursive, Iterations, a data file and Load test - because the scenario **is** the folder: the sequence is the tree's own ordering, and a step list authored here would be a second source of truth for it. Invalid iterations are refused in the dialog; the engine's own rejection (which names the step that would not compose) is shown in place rather than as a toast that scrolls away.

**Load test** (issue #357) is the same plan on a different executor: the payload gains a load `mode`, and its presence is exactly what the engine reads to choose one, so a design-mode payload keeps its meaning by carrying no mode at all. It lives here rather than in the request builder's `LoadTestConfigDialog` because that dialog's target is the request that is open, and a scenario's target is a folder - picked here, by the tree that already owns the choice. Turning it on swaps Iterations (a duration-bounded run has no use for a pass count) for Virtual users and Duration, and swaps what happens after the `202`: a load run publishes `metrics` ticks and no `step` events, so it attaches `loadTestService` and opens the **dashboard**, where a design-mode run attaches `scenarioRunService` and opens the runner tab. Attaching the wrong one is not a degraded view, it is a permanently empty one.

`modules/collections/DataFilePicker.tsx` is the data-file half (issue #402). It reads a CSV/TSV/JSON/JSONL file through a hidden `<input type="file">` + `FileReader` - the `ImportModal` precedent, deliberately no Electron dialog IPC - decodes its **bytes** (`decodeDataFile`, so a non-UTF-8 export is named rather than parsed into question marks), parses it with `services/data-files/`, and previews the first ten rows in the `ui/table.tsx` grid. Two things it exists to say **before** the run rather than after: everything the engine would reject (a ragged row, a duplicated column, a non-object, a line that will not parse, a set over `maxScenarioDataRows` or `maxScenarioDataBytes`) is refused here with the row, line or setting named - the two caps read live through `useDataFileLimits` rather than restated, so raising one engine-side is enough, and the **resolved iteration count** is stated, because an explicit `iterations` wins over the row count - a 500-row file with Iterations left at 1 runs once. Picking a file blanks a **pristine** `1` so the field shows what will happen - pristine and not merely equal to `1`, because a deliberately typed `1` reads the same and clearing it would turn one pass into a full pass per row, and `iterations` is then omitted from the payload entirely: the engine owns "absent means one pass per row", and a client computing the row count itself would be a second copy of that rule. The previewed rows and the sent rows are one array; the parent holds the single `ParsedDataFile`. Rows are held for the run request and no longer - nothing persists them, here or engine-side. The user-facing file contract lives in [Data-Driven Runs](data-driven-runs.md).

`CollectionDetail/DataTab.tsx` is the authoring-time half of the same file (issue #599, phase 1 of #598). It reuses the picker in `mode="declare"` - same parser, same refusals, no iteration arithmetic - and turns the previewed file's columns into `collection.dataSchema` through `useUpdateCollectionMutation`. **Clear** sends `dataSchema: null`, not `{}`: the engine reads absent as "keep", so a cleared contract is only expressible as a null that survives to the wire. What is stored splits by what it is true of: the **columns** are the same on every machine and ride the engine row; the file's **path** is true of one filesystem and lives in `stores/data-file-store.ts`; the **rows** are true of nobody and are stored nowhere at all. When both a contract and a file are in hand, `services/data-files/schema-diff.ts` renders the mismatch in both directions into the picker's warnings slot - shared with the run dialog, so the tab and the runner cannot describe the same file differently.

`CollectionDetail/SpecTab.tsx` is the same two-halves split one contract over (issue #638, phase 1b of #625). The **document** and the binding (`collection.openapi` -> the engine's `spec_documents`) are the same on every machine and ride the engine; a picked file's **path** is true of one filesystem and lives in `stores/spec-file-store.ts`, which holds a path and a file name and no spec content at all. Binding a collection that was not imported from a spec goes through `services/openapi/spec-operations.ts` - which reads the operations back out through the **import parsers** rather than walking `paths` a second time, so the two cannot disagree about what a document contains - and `services/openapi/operation-match.ts`, which reduces both sides to a path shape (origin, query and fragment dropped; `{{petId}}` and `{petId}` flattened alike) and refuses an ambiguous pair rather than guessing. The three writes a bind performs are `useBindSpecMutation` (`queries/specs.ts`): store the document, bind the collection, stamp the matched requests - in that order, because each needs the one before, and a stamp that fails is reported without pretending the binding did not happen. The user-facing contract lives in [OpenAPI Collections](openapi.md).

`CollectionDetail/SpecSync.tsx` is the read half of keeping that binding in step (issue #654, phase 2b of #625), and its whole design follows from writing nothing: `services/openapi/spec-refetch.ts` re-reads the document from the URL the binding stored or, failing that, through the `specFile:read` gate the picked file's siblings already use - the document naming *itself* as the file beside itself, rather than a second gated channel repeating the extension allowlist and the byte cap - and runs it through `bundleExternalRefs`, because the stored document is the bundled one and an unbundled comparison would report every external `$ref` as a change forever. "Up to date" is **byte equality against the stored document**, not a renderer-side SHA-256: the engine hashes what it stores (`spec_content_hash`), and a second hasher here could only drift. `services/openapi/spec-diff.ts` then produces the three buckets from two documents and the requests, as a pure function - it follows an operation by `operationId` first and path shape second, so a path moved under a stable id and an id moved under a stable path both stay one operation while both-moved is disclosed as a removal plus an addition, and it flags a field as **user-touched** three-way (what the request holds is neither the new document's value nor the bound one's), which is the flag the apply half may not overwrite silently.

The apply half (issue #655, phase 2c) keeps the same split: `services/openapi/spec-apply.ts` is a pure module that turns a diff plus a set of ticks into the `POST /specs/sync` body, so the two rules a user's work depends on - a field marked user-touched is never in the payload unless it was ticked, and a deletion is never a default - are provable without a row to damage. It reuses `services/importers/request-payload.ts` for the draft-to-payload mapping, shared with the import orchestrator so a field added for one write path cannot go missing on the other, and files an added operation in the tag folder an import would have used (matched by name, created once per tag). The write itself is one call and one engine transaction (`useSyncSpecMutation`): the document, the moved binding and every created, updated and deleted request land together or not at all, and the engine - not the payload - is what keeps a user-saved example out of a refresh and a request outside the bound subtree out of reach.

`modules/collections/ExportSpecDialog.tsx` is the way back out (issue #630, phase 5 of #625), opened from a collection row's ⋯ menu and from the Spec tab - one dialog, so the two entry points cannot describe the same export differently. It reads through `useOpenApiExportSource.ts` (the subtree's requests, each request's examples under the keys the Examples tab already uses, and, for a bound collection, the document itself) and assembles app-side in `services/exporters/` - the `codegen` precedent: the engine owns the canonical rows and gains no export route.

Which of the two directions runs is not a setting but a fact about the collection, and the dialog says which before anything is written. A **bound** collection exports its own stored document, patched: operations nothing here claims are removed, request values become declared parameters' examples, stored examples become response examples, and every member Vayu does not model is carried through by simply not being visited. A **free-form** collection gets a skeleton - "a starting point, not a contract" in the dialog's own words - which invents nothing: no schema that was not read off an example body, no `required` from a row's enabled toggle, no response for a status nobody saved. Everything either direction could not carry is counted on screen, zeros included. Delivery is a Blob and an `<a download>`, the same file-to-disk path `ResponseActions` uses; there is no save-dialog IPC and none is needed. The user-facing contract lives in [OpenAPI Collections](openapi.md).

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
the engine remains the run-time authority.

`RunCollectionDialog` **pre-fills from that declaration** as part of mount, which is what keeps the dialog's mount-is-reset contract intact: if `data-file-store` holds a path for this collection it re-reads it over the `dataFile:read` IPC (`electron/data-file.ts` - extension allowlist plus the engine's fetched `maxScenarioDataBytes`, the one channel on which the renderer names a path), decodes and parses it with the same modules the picker uses, and diffs it against the declared columns. A file that has moved leaves the picker empty and a sentence saying so - a warning, never a blocker, because a run without a file is a legal run and re-picking is the whole remedy.

The picker is told **which run it is for** (`loadTest`), because a row means something different in each and describing one of the two is being wrong about the other (issue #449). In design mode a row is an iteration and the file's length is the run's length. In load mode the rows are claimed from a cursor every virtual user shares, wrapping for as long as the duration lasts - so the row count says nothing about how long the run is, only that no two virtual users start on the same row while unclaimed rows remain (past the wrap they do share rows), and the resolved-iteration sentence is replaced rather than shown against a pass count a load run does not have.

`services/data-files/` is the parser: `tabular.ts` (a hand-rolled RFC 4180 tokenizer - quoted delimiters, embedded newlines, doubled quotes, CRLF - shared by CSV and TSV, which differ only in the delimiter) and `index.ts` (format detection by extension with a content sniff fallback, the header rules, the JSON/JSONL paths). CSV and TSV values are **strings, always**, so `007` survives; JSON and JSONL keep native types, and the preview states the asymmetry. The header row *is* the mapping - column names become `{{data.column}}` tokens and `pm.iterationData` keys - so an empty or duplicated header cell is a parse error rather than a column nobody can address.

`LoadTestDetail` is **mode-aware** (header strip + tabs adapt to the run's mode, derived via `reportToDerived` → the same `DashboardDerived` shape the live dashboard uses) and composes the tabbed report under `main/components/`:

| Component | Role |
|---|---|
| `OverviewTab.tsx` | Summary - renders the dashboard's mode-adaptive `HeroRow` + `ModeStatsRow`; the Rate-Control card is gated to `constant_rps` |
| `RunEvents.tsx` | The run's detected anomaly windows in words (`detectAnomalies`); silent for a clean run |
| `PerformanceTab.tsx` | Latency/throughput detail |
| `SamplesTab.tsx`, `SampleRequestCard.tsx` | Sampled request/response pairs |
| `ScenarioStepsTab.tsx` | Per-step latency and counts for a **scenario load run** - see below |
| `TimingBreakdown.tsx` | DNS/connect/TLS/first-byte/download breakdown |
| `LatencyMetric.tsx`, `HistoricalChartsSection.tsx` | Metric cards + historical charts |
| `MonitorSummary.tsx` | Per-series min/avg/max for the run's server-vitals scrape, under the Performance tab's chart. Present whenever `report.monitor` is - including the run whose every scrape failed, which has a failure count and no line to draw, and read as an unexplained empty chart before it |

A **scenario load run** lands in `LoadTestDetail`, not `ScenarioRunView`: it is `type: "load"`, publishes ticks and reports percentiles like any load run, and its target simply happens to be a sequence. Two things follow, both keyed off `report.scenario.steps` being present rather than off a run-type flag - that array is what this pane actually needs to render. It has no single method and URL, so the header strip says what the sequence was instead of the "GET Unknown URL" fallback, which the reader cannot tell apart from a broken run. And it stores no per-step `results` rows - one row per step per iteration per virtual user is what a load run exists not to keep - so `ScenarioStepsTab.tsx` renders the engine's per-step histogram breakdown, the only per-step record such a run has. Its `(n short)` marker is the visible shape of an errored step ending its iterations early, which otherwise reads as a run that simply lost requests. The **Tests** column is the deferred per-step validation - each step's own post-request script replayed after the run against that step's sampled responses - and shows a dash, never a `0`, for a step that asserted nothing: the engine omits the object rather than writing zeros, because "no assertions" and "no failures" are different answers.

> History detail reuses the live dashboard's `hero/`, `charts/`, and `stats/` components by feeding them a `DashboardDerived` built from the stored report (`reportToDerived`), so live and historical views stay visually consistent.

## Variables (`modules/variables/`)

- **Sidebar (`sidebar/VariablesCategoryTree.tsx`)** - tree of variable scopes (globals, collections, environments); receives `collections` + `environments` from the Sidebar.
- **Main (`main/`)** - `VariablesMain.tsx` (screen `"variables"`) hosts `VariableTableEditor.tsx`, the table editor for the selected scope, including the active-environment selector.

**`VariableTableEditor` does not mount the [shared key/value table](#shared-keyvalue-editor-componentssharedkeyvalueeditor), and that exclusion is permanent** (decided in #564, re-examined and confirmed in #587). It is not a copy of that table - it is a different one: a per-row type select and secret toggle, a masked value cell, text committed on blur while toggles save immediately, and rows ordered by a `createdAt` stamp rather than by a trailing-blank rule. Mounting the primitive here would mean giving it a dynamic column model, a commit model, and variables-domain fields on `KeyValueItem`, redesigning a primitive for one consumer at the expense of its three others. What the "a hand-rolled copy of a primitive does not receive the primitive's fixes" rule *does* bind is the reveal control: `ui/secret-input` was extracted from this cell and then received fixes (the `tabIndex={-1}` removal, `aria-pressed`) the leftover copy never got, so the value cell mounts `SecretInput`. `main/key-value-parity.test.tsx` pins what the two tables must keep in common - control height, checkbox clearance and sizing, the shared `rowActionDestructive` variant, and that reveal control - each read off the primitive rather than off copied literals, so a fix to either side that skips the other fails.

**Rows carry an editor-local id, and it is what React keys them by.** Reveal state lives inside `SecretInput`, so reconciliation decides which row owns it - and while rows were keyed by array index, deleting a revealed secret handed its mounted field to the row that shifted up, which then rendered unmasked (#621). A variable has no identity of its own to key by (`key` is editable, `createdAt` may be absent), so each row is stamped with a session-monotonic id at load and at insertion. The id is UI state and is never persisted: `performSave` builds each entry field by field. A reseed of the **same** scope carries the ids over, matched by variable name - a reseed is usually the cache echo of a save this editor just made, and fresh ids there would remount every row, re-masking a revealed secret and pulling focus out of the field being typed in. A **different** scope mints fresh ids, since those are different rows that merely share names. `main/secret-reveal-identity.test.tsx` pins both halves.

## Settings (`modules/settings/`)

Same nav/content split as Variables: the category tree renders in the **Drawer** (`settings` view), not inside the settings tab. Selecting a category sets `useSettingsStore.selectedCategory` **and** opens the settings tab, so `SettingsMain` shows that panel. There is no `SettingsLayout` two-pane wrapper anymore - the Drawer is the left pane.

- **Sidebar (`sidebar/SettingsCategoryTree.tsx`)** - settings category navigation and the search over every setting; rendered by the Drawer.
- **Main (`main/`)** - `SettingsMain.tsx` (screen `"settings"`) hosts the app-settings category panels under `main/panels/`: `AppearancePanel.tsx`, `DashboardPanel.tsx`, `LoadTestingPanel.tsx`, `GeneralPanel.tsx`, `McpSettingsPanel.tsx`, `NotificationsPanel.tsx` and `EditorPanel.tsx`, plus the shared `ClientSettingsPanel.tsx` wrapper, `FontPicker.tsx`, and `SettingControls.tsx` primitives. `GeneralPanel` composes two cards of its own: `UpdatesCard.tsx` and `CookiesCard.tsx` (the engine's cookie jar - what it holds per environment, and the button that empties it). `app-panels.ts` is the panel registry/metadata, `app-settings.ts` the catalogue of the settings inside those panels (see Search), and `engine-categories.ts` the engine-side registry. (The former monolithic `UISettingsPanel.tsx` was split into these panels in PR #55.)

The engine categories render from `GET /config` metadata alone - no per-key branching in the component. Two flags on each entry shape the screen: `requiresRestart` draws the "Restart Required" chip (and, once saved, the "Pending" chip plus the banner and the Dock's signal), and `advanced` moves the entry into a collapsed **Advanced** section at the bottom of its category. Both are read as fields; the `"(Requires Restart)"` label substring they replaced is gone, and `config_route_test.cpp` guards it from coming back. The collapsed state is deliberately not persisted, and resets when the category changes.

**Units come from the entry, not from the key.** `ConfigEntry.unit` (`ms`, `sec`, `days`, `bytes`; absent for a count) is passed straight to `NumberSettingRow`'s `unit` prop, which renders it inside the input - the one place a unit is stated, so no label appends `(ms)` and no description spells it out. `bytes` also selects `formatBytes` / `formatSizeRange` for the value, the range hint and the default line, so `104857600` reads as `100.0 MB`; anything else is shown verbatim, and a unit this app has not heard of still reaches the screen. That last branch used to be `isSizeConfig`, a hardcoded list of three keys in `utils/format-size.ts` - the app re-deriving what the engine owns, so a byte-valued entry seeded engine-side rendered a bare number until someone edited the array (and two retired keys sat in it unnoticed). The list is gone; `isByteUnit(entry.unit)` reads the declaration. Entries sort **by label**, not by key: the key is an internal name, and seed order is not a stable alternative because the engine rewrites a changed setting with `INSERT OR REPLACE`, which reassigns its rowid.

Adding an app panel is three edits and no branching: a member on `ClientSettingsCategory` (`types/domain.ts`), one entry in `APP_SETTINGS_PANELS`, and the panel file. The sidebar tree and `SettingsMain` both read the registry. The engine half works the same way: `ENGINE_SETTINGS_CATEGORIES` (`modules/settings/engine-categories.ts`) carries each category's label, description, icon and sidebar order, and both the tree and the settings header render from it - they used to hold two hand-maintained maps of the same five names.

**The six engine categories** (#586), in sidebar order, which is by likelihood of visit rather than by seed order: **Core** (base capacity, threading, storage internals), **Network & connectivity**, **Services** (streaming requests, webhook inboxes, mock servers, OAuth issuers - the Dock's word for that group, and its `Radio` icon), **Observability** (server monitoring and live metrics), **Data & retention** (capture and truncation budgets, run retention), **Scripting environment**. Labels are sentence case, matching the app panels they sit under in the same sidebar. The set is closed on the engine side too - a seeded entry in a category this registry does not declare is dropped from the index and rendered nowhere, which `config_route_test.cpp` pins against the seed. "Observability & Data" held 24 of 48 entries before the split; "Database Performance" was a sidebar row for three, and folded into Core. App-side, the MCP panel reads **AI agents (MCP)** - the sidebar's only unexpanded acronym, kept in the parenthetical so it stays findable by eye.

**One knob, one editor.** A `/config` entry whose editor is an app panel row is listed in `ENGINE_SETTINGS_EDITED_IN_APP` (`modules/settings/engine-settings-edited-in-app.ts`) and drops out of the engine list: `liveReplayWindowMs` rendered both as "Live Chart Window" here (staged edit, Save bar) and as "Chart window" in Dashboard (autosave option buttons), so one value carried two labels, two save models and two search results, and staging one while flipping the other left this row showing a value nobody saved. The entry stays seeded, on `GET /config` and writable through `POST /config` and MCP; only the second editor is gone. Search folds the engine key into the owning row's keywords rather than indexing it separately, so `liveReplayWindowMs` - the name the docs, the logs and `update_config` use - still finds the setting, lands on the row that edits it, and returns one result. Related: General > Data management links to Engine > Data & retention, because that card shows and clears stored runs while the knobs bounding them live in the other section.

### Search

`lib/settings-index.ts` is a **pure** module: `buildSettingsIndex` flattens three catalogues into one list - the app panels (`app-panels.ts`), the settings inside them (`app-settings.ts`) and the engine entries from `GET /config` - and `searchSettings` filters and ranks it (label, then id, then keywords, then description, then category label; an empty query means "not searching" and returns everything). It is deliberately free of React and stores.

`modules/settings/useSettingsIndex.ts` is the half that names the catalogues and reads the `/config` query. Both consumers call it - the sidebar's search box and the palette's `useSettingsItems` source - rather than each assembling the four inputs inline, which is the "one branch defines it, the other re-derives it" wiring defect this repo keeps finding. One index, one ranking, two UIs. The sidebar's query text lives in `settings-store` (`searchQuery`) for the same reason the index is shared: the palette's escape row hands its query over, so the drawer opens already filtered.

**Index the settings, not the screens.** The first version held panel titles and engine entries only, and a user searching "theme", "color" or "font" got nothing - the panel that holds all three is called "Appearance" and describes itself as "the look and feel of the application". `app-settings.ts` is the app-side catalogue that fixes it: one `AppSettingDescriptor` per setting (`anchor`, `panel`, `label`, `searchText`, optional `keywords` for the words a user types that the copy never uses - "dark mode", "accent", "zoom"). A new app setting needs an entry here, or it is unfindable.

**Both halves carry keywords, and neither renders them.** The engine sends its own on each `/config` entry (`ConfigEntry.keywords`, always an array, empty for the entries that declare none) - "ram" for `dbCacheSize`, "deadline" for `defaultTimeout` - so an engine setting is findable by a word that is in neither its label nor its description, which it was not while the index passed `[]` for that half. The field is a match term and has no reader in any component: it is the one deliberate exception to "grep for a reader before adding a field", and both type declarations say so. Adding a keyword that repeats a word the entry already carries is a defect, not a freebie - label, id and description all rank above keywords, so the duplicate only lifts the entry over better matches; the engine guards its seeds with a test.

**The catalogue owns the name; the panel owns the prose.** `label` is not a description of the heading, it *is* the heading - every panel renders `appSetting("<anchor>").label` rather than typing the string a second time, so a rename happens once and reaches both the screen and the search result. That is why the labels read as they do ("Font", not "Interface font"): the result row already prints the owning panel underneath, so qualifying the name here would only offer a title the panel never shows, and the qualifier a user might still type goes in `keywords` instead. `searchText` is the one field that stays hand-written, and it is **match text, not display text** - nothing renders it. A panel's own copy is markup (`<Kbd>` chips, live counts, conditional notices), so there is no string to lend; the catalogue writes a one-sentence summary of the block instead.

Both halves are checked rather than trusted, by `app-settings.drift.test.tsx`, which renders every panel: a declared `anchor` has to be on screen (it is the `data-setting-anchor` the panel puts on the block), and the block's heading has to equal the declared `label` **exactly** - "Theme Modes" contains "Theme Mode", and a guard that accepts that is not a guard. A heading is one of four shapes and the block cannot say which, so the test resolves them in reading order: a row that names itself (`data-setting-row`, which `NumberSettingRow` and `ToggleRow` write from the same prop they print), then a `CardTitle`, then an `Eyebrow`, then a row nested inside. Rendered, not source-scanned - both the anchor and the label arrive through props, which no scan of a panel file would see.

Revealing a result is one mechanism for both halves: the sidebar passes the result's `anchor` as `useSettingsStore.highlightedKey`, and `useRevealedSetting` (mounted by `SettingsMain` and by `ClientSettingsPanel`) finds `[data-setting-anchor="<key>"]`, scrolls it into view, outlines it for `HIGHLIGHT_MS` and clears the key. It waits for the block through a `MutationObserver`, because the panel usually mounts after the key arrives. The one thing the attribute cannot do stays in `SettingsMain`: an entry inside the collapsed **Advanced** group is uncollapsed first, or there would be nothing to reveal.

### Row primitives and save models

`SettingControls.tsx` holds the shapes every panel shares, and panels use them rather than re-rolling one - a hand-rolled copy never receives the primitive's fixes:

- `OptionButtons` - the pick-one tile grid. `preview: (isSelected) => ReactNode` per option draws the theme badge, the accent swatch or the roundedness shape, so Appearance no longer re-implements the selected-card style three times.
- `ToggleRow` - label (a node, for the MCP tool rows' `<code>` and counts), description, `disabled`, `title`. Takes an `anchor` like `NumberSettingRow` does, for the switches search reveals individually (Word wrap, Line numbers, Minimap), and names its box with `data-setting-row` from the same string that names the switch.
- `NumberSettingRow` - input, unit suffix, range hint, `aria-invalid` + message, and the Default line. Its `commit` prop is the one thing the four old copies really disagreed about: `"change"` for settings that apply live, `"blur"` for owners that do real work per write (the MCP caps cross IPC). An unparseable draft is never committed - it stays in the field until it is a number again. `data-setting-row` names the row's box.
- `DefaultValueLine` - "Default: x" plus the reset that goes there. Used by `NumberSettingRow` and by the boolean/enum/string engine cards, so every entry type has one.

Three save models coexist and each says which it is: app panels state `AppSettingsPanel.saveNote` (defaulting to `DEFAULT_SAVE_NOTE`, "Changes are saved automatically.") in the `ClientSettingsPanel` header, MCP overrides it, and the engine view states its staged-then-saved model beside the Save bar. Leaving an engine category still flushes its staged edits, and now **says** when one was dropped for being invalid instead of discarding it silently. A card's Revert discards a staged edit; Reset goes to the shipped default - one name each, for the two different things.

`LoadTestingPanel.tsx` is the ceilings the load-test dialog offers - the app's own policy, clamped to the engine's crash guards on the way into `client-settings-store`. The engine's bounds themselves are deliberately **not** settings; see `docs/app/api-integration.md` (Dialog ceilings are a user setting).

## Webhook Inbox (`modules/inbox/`)

The receiving half of the app (issue #480): an engine-hosted listener that records the requests
sent to it, so building a webhook consumer needs no cloud tunnel. Engine contract:
`docs/engine/api-reference.md` (Webhook Inbox).

- `index.tsx` (`InboxView`, screen `"inbox"`) - start/stop/clear/delete, the URL with a copy
  control, the running/live badge, the inbox switcher, the capture list and the detail pane. Clear
  (Eraser) empties the capture list; Delete (bin) ends the inbox itself, so the two adjacent
  destructive controls do not share an icon. The switcher is a
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
  regardless until #565.
- `CannedResponseControls.tsx` - all four fields the engine serves: reply status and delay inline,
  body and headers behind a disclosure that opens on its own when either is set. It showed status and
  delay only, so a reply body or header set configured by an MCP tool or a bare curl was invisible
  and uneditable here (issue #556). Its own component so every field can be a draft (typing `50` on
  the way to `500` must not push a 50 at the next caller) and so re-seeding them from the engine is a
  remount - `InboxView` keys it on `cannedResponseKey`, which covers all four - rather than a
  `setState` inside an effect. Apply sends the whole response, not a diff: `PUT /inbox/:id` is a
  merge-patch, so an omitted `headers` is how a header the user deleted comes back. On a **stopped**
  inbox every control is disabled and says why - the route still merge-patches a stopped record, so
  a live-looking panel there is an edit accepted for a reply nothing will ever send. The reply
  headers are
  [`KeyValueEditor`](#shared-keyvalue-editor-componentssharedkeyvalueeditor) rows, with no `variables` scope
  passed - a canned reply is echoed verbatim, so there is nothing to resolve. They were local
  `Input` pairs until #564 made the primitive mountable outside `RequestBuilderProvider`; the
  table's trailing blank row replaced the panel's own "Add header" button.
- `CaptureDetail.tsx` - one capture, rendered through `UnifiedResponseViewer` and `buildRawRequest`.
  A capture is an exchange with no response, which that viewer already handles; a request you
  received should read like one you sent.
- `useInboxLive.ts` - the SSE stream. New captures are merged into the same query cache
  `useInboxCapturesQuery` fills, not kept in a second list beside it - two lists would need
  reconciling on every clear, and whichever the detail pane read would decide which was true.
  The reconnect is the hook's own, not the browser's: `EventSource` treats a non-200 as fatal,
  and a reconnect landing inside the engine's dead-socket window meets a `409`, so a single
  drop used to end the stream for the life of the tab. It retries with a jittered backoff,
  resumes from the last capture id it saw (`?lastEventId=`, since no API sets a header on a
  fresh connection), and once the retries are spent reports `stopped` so the surface can say
  so and offer a Resume rather than leave the badge reading `Running`.
  A stream also ends because somebody *stopped* the inbox - from the drawer, an MCP tool or curl -
  and that close is indistinguishable from a drop. So before spending a retry the hook refetches
  the inbox list and reads the record: gone or `running: false` means no reconnect, and the tab
  reflects the stop inside the close instead of on the next `SERVICES_POLL_INTERVAL_MS` poll. A
  refetch that failed leaves the last good list, which still says running - a blip must still
  retry.
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
and the Dock's running-services indicator activates the same view. Until #502 the Launcher tile was
the *only* way in, and a running inbox was invisible once its tab was closed.

## Services (`modules/services/`)

One home for the app's **local services** - the things that keep listening after you switch tabs
(issue #502). Rendered as the `services` drawer view; the Dock's indicator and the welcome tile
both activate it.

- `ServicesPanel.tsx` - the view. Three groups: **Webhook inboxes**, **OAuth issuers** and **Mock
  servers**, each with a one-sentence empty state saying what the service would give you - this
  drawer is also the features' discoverability. The first two carry their own start affordance in
  the group header; the third deliberately does not (see below). An inbox row opens the
  inbox *tab* (the drawer lists, the tab shows the captures) and carries copy, stop (running rows
  only) and **delete** (every row); an issuer row expands in place to its token and authorize URLs,
  a copy for the HS256 signing key, its configuration in one line, a live `failureMode` switch, and
  - in `slow` only - the delay that mode answers after, committed on blur rather than per keystroke.
  The inbox group's affordance is **New inbox** (Plus), matching **New issuer**: it always mints a
  new listener, and as a Play labelled "Start inbox" beside a stopped row it read as "restart that
  one", which nothing here does (issue #553).

  **Mock servers (#481 phase 2) have no start affordance here, and that is not an omission**: a
  mock needs a collection to serve, and this drawer has none selected. The collection header owns
  the start (`CollectionDetail/MockServerControl`); this group owns the list, so a mock started from
  any collection - or from an MCP tool, or curl - can be found and stopped where every other running
  listener is. A mock row leads with the **collection name** (two mocks of one collection differ
  only by port) and expands in place to its base URL, its latency/error-rate line, and the **route
  table** from `GET /mock/:id/routes` - the answer to the only question this surface gets asked,
  "why did the mock 404 that?". The latency/error-rate line **reports**, and correctly offers no
  control: both are set when the mock starts (the collection header's options dialog, issue #570)
  and are start-time for the same reason the route table is, so a live switch here - the shape the
  issuer row's `failureMode` takes - would need a `PUT /mock/:id` the engine deliberately does not
  have. The table is fetched when the row is opened and never polled: it is
  a start-time snapshot that cannot change under a running mock. Stopping a mock removes it from the
  list, like an issuer and unlike an inbox, because a mock holds nothing that outlives its listener.

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
  (#555 item 6, then #565 item 1) - a hand-rolled copy does not receive the primitive's fixes. Rows are ordered **by port**, because the engine lists them in map order (not stable across
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
- `useRunningServices.ts` - `useRunningServiceCount()`, shared by the drawer and the Dock. One place
  because the two lists disagree on their own terms: a stopped inbox stays listed with
  `running: false`, while a stopped issuer is gone from the engine's list entirely - and because a
  **disconnected engine is running none of them**, which is the gate this hook holds so that no
  caller renders a green count off a stale cache (issue #555).
- `failure-modes.ts` - the four `failureMode` labels, the engine's bounds, and the row's
  one-line summary. Shared so the badge, the live switch and the dialog cannot name a mode
  differently.

**No new tab type.** An issuer's whole management surface fits a row plus a dialog, and a `TabType`
costs three switch statements and the coverage guard. The inbox keeps its tab because a capture
list needs the width.

**Data:** `queries/inbox.ts` and `queries/mock-issuer.ts`, both polled at
`TIMING.SERVICES_POLL_INTERVAL_MS`. They are polled rather than driven by this app's own mutations
alone because the MCP tools and a bare curl reach the same engine routes - an indicator that only
knew what this window started would contradict its own promise.

## Welcome (`modules/welcome/`)

Vayu's new-tab surface - rendered for the `welcome` tab (opened by TabStrip's `+`), when no tab is open, and for a request tab with no entity.

It is **not** a resume screen: `openTabs`/`activeTabId` are persisted and restored, so returning users land back on their own tabs. Its job is to start something new. Keep marketing content off it - a feature pitch and static perf claims were removed for exactly that reason. Anything already visible in the Collections sidebar or History drawer is a duplicate and does not belong here either.

- `WelcomeScreen.tsx` - container: queries, picks the state. Holds on `isLoading` so the first-run screen never flashes at a returning user. The new-request flow itself is `hooks/useNewRequest.ts`, shared with the palette's `new-request` command - two entry points must not disagree about where a request lands. This screen renders that hook's `pickerProps` and nothing more.
- `EmptyState.tsx` - fresh workspace. Import leads (people arrive carrying Postman/Insomnia/OpenAPI collections). The only state with branding.
- `Launcher.tsx` - populated. Action row, recent runs, workspace counts. No branding; the logo is in the title bar.
- `components/` - `ActionTile`, `RecentRuns`, `FooterLinks`. The action row is six tiles: New
  request, Search, Import, History, Variables, Services. Services and History both activate a
  drawer view rather than opening a tab. Search opens the command palette - the
  chord alone is undiscoverable, and this grid is where the app teaches its own surfaces.
- `LauncherSkeleton.tsx` - one skeleton tile per real tile. It has drifted a tile behind the
  Launcher before; `WelcomeScreen.test.tsx` now asserts both grids against one constant.

Doc links go through `window.electronAPI.openAppLink(key)`, a keyed IPC channel - the renderer cannot open arbitrary URLs, and a plain `<a target="_blank">` would spawn an unmanaged Electron window.

Design rationale: `app/src/modules/welcome/README.md`

## Command Palette (`modules/palette/`)

The ⌘K/Ctrl+K overlay: reach any open tab, saved request, collection or app view by name, and
run any command by name. Mounted once by `Shell`, alongside `ImportModal`.

- **`CommandPalette.tsx`** - the dialog, the chord, focus restoration, the open flag
  (`useLayoutStore.paletteOpen` / `setPaletteOpen`, deliberately not persisted), and the host
  for the dialogs its commands open (see `useCommandSurfaces.ts` below).
- **`sources/`** - one hook per family, each returning `PaletteItem[]`. Two shapes of source:
  the **shallow** ones return everything they know and let cmdk filter it - `useTabItems` (open
  tabs), `useEntityItems` (requests + collections), `useViewItems` (drawer views and singleton
  tabs) - while the **deep** ones take the query, because their corpus is too large to render:
  `useSettingsItems` (every app setting and engine entry, through the shared settings index),
  `useVariableItems` (environment names and variable keys across every scope) and `useRunItems`
  (server-backed, `GET /runs?q=`). `commandItems.ts` is a plain function, not a hook: it owns no
  data, it maps the [command registry](#command-registry-libcommands) onto the same shape.
- **`useCommandSurfaces.ts`** - the collection picker, the run dialog and the theme hook, which
  three commands need and no store can hold. Their original hosts are not always on screen (the
  welcome screen's picker only on the welcome tab, the tree's run dialog only while the drawer
  is open), so the palette mounts its own - the same components, driven by the same calls. It
  also merges the surfaces a *mounted feature* contributes (the request builder's live draft,
  for "Load test …") - see [Command Registry](#command-registry-libcommands).
- **`types.ts`** - the `PaletteItem` shape, the fixed group order, and `rankForEmptyQuery`.
- **`PaletteResults.tsx`** - grouping and rendering. **Mounted only while the palette is open**,
  the same cost rule the context bar applies to a collapsed section: a shut palette holds no
  query observers on collections, requests or run history.

Three things about it are load-bearing:

- **The chord is on the capture phase**, unlike every other shortcut in the app (which lives in
  `Shell`'s bubble-phase keydown map). Monaco treats ⌘K as the start of a chord and stops it
  propagating, so a bubble listener never sees the key while the caret is in an editor.
  `PALETTE_CHORD` lives in `constants/shortcuts.ts` so the handler and every label that
  advertises the chord read one definition.
- **Focus goes back where it came from**, and that is the palette's own code: Radix's
  `FocusScope` restores to a dialog's *trigger*, and a palette summoned by a chord has none, so
  focus would land on `<body>`. The previous element is captured from a store subscription
  rather than an effect - child effects run first, so by the time an effect here fires the
  dialog has already taken focus.
- **Tab rows are named by `components/layout/tab-descriptors.ts`**, the same hook `TabStrip`
  uses. A tab must not read "GET /v1/orders" in the strip and "Request" in the palette.

Ranking: cmdk's own match score once anything is typed; on the empty query, `rankForEmptyQuery`
puts the most recent first - focus time for tabs (`tabFocusedAt` in `tabs-store`, session-scoped),
last-run time for requests (from the run history already in cache). Groups render in a fixed
order (Tabs, Requests, Collections, Views, Commands, Settings, Variables, Runs) so the list does
not reshuffle as you type. Settings is its own group rather than more Commands: twelve sections
would bury the handful of things the palette can actually *do*.

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
- **An escape row renders in a group of its own**, below the results. cmdk re-sorts a group's
  items by score, and an escape row has to carry the query verbatim to survive that filter -
  which would score it above every result it is an escape from. A separate group has its own
  item container, so nothing sorts across the boundary.
- **A deep row carries what matched in its `keywords`**, because cmdk filters the rendered list
  a second time and would otherwise drop rows the source already matched - decisively so for
  runs, where the engine matched against stored snapshot text that no row prints.

Two invariants are tested rather than commented. **A variable's value is never indexed**, secret
or not (`secret` is a masking hint, so trusting it would leak every token nobody flagged) - held
in `sources/useVariableItems.test.ts` against the source's output, because cmdk's second filter
would hide an indexed value from any DOM assertion. And **an engine that is down hides the Runs
group silently**: typing is idle input, and idle input must never raise a toast.

**Entry points:** the chord, and the `Search` tile on the welcome Launcher. The title bar's
search bar (#529) is the third and becomes the primary one - it flips the same store flag.

## Command Registry (`lib/commands/`)

Every user-facing *action* the app offers by name, declared once. **A new action is declared
here, and its surfaces point at it** - a menu item, a tile or a palette row is a way of reaching
a command, never a second definition of one. Before this, "open settings" existed separately in
the native-menu bridge, the Dock, the settings sidebar and a keydown case, and nothing kept them
in step or could enumerate them.

- **`types.ts`** - `Command` (`id`, `title`, `keywords`, `group`, `icon`, `available?`,
  `perform`) and `CommandContext`. A `title` may be a function of the context, which is how a
  contextual command names its target: `Run "payments"`, not `Run collection`.
- **`registry.ts`** - the roster. Actions (new request, import, run collection, load test, close
  tab, toggle theme, open settings) plus one command per settings section, **generated** from
  `app-panels.ts` and `engine-categories.ts` so a section added there appears here without an
  edit and cannot be named differently.
- **`context.ts`** - `baseCommandContext()`, the React-free snapshot for a caller that is not a
  render (the native-menu bridge). `hooks/useCommandContext.ts` is the full version.
- **`live-surfaces.ts`** - the channel a *mounted feature* contributes a surface through. One
  slot, one contributor: the request builder's start-load-test handler.

Two rules make it work without a dependency-injection tangle:

- **Stores are not in the context.** They are module singletons, so a `perform` calls
  `useTabsStore.getState().openTab(...)` directly. The context carries only what `getState()`
  cannot answer: the active tab and its label, the collection that tab shows, and the surfaces.
- **A command that needs a surface the caller cannot offer declares itself unavailable** rather
  than throwing when picked. `CommandSurfaces` is optional on the context; the menu bridge omits
  it, so "New request" is simply not among the commands it can run.

### When a surface is a store, and when it is a live contribution

Most of what a `perform` needs is a store, and a store is always the answer when the state
outlives any one mounted view. `CommandSurfaces` covers the rest, and it has two halves:

- **Host-owned** (`newRequest`, `runCollection`, `toggleThemeMode`) - dialogs and hooks that are
  React but that *any* rendering caller can mount for itself. The palette does exactly that in
  `useCommandSurfaces`, so offering `surfaces` at all means offering these three.
- **Contributed by a mounted feature** (`startLoadTest`) - state that exists only inside one
  component tree and cannot be lifted without copying it. Starting a load test needs the request
  builder's **live editor draft**, before autosave has run; the palette is a sibling of
  `RequestBuilderProvider`, so a command reading a store would find only the last *saved* request
  and would silently run the old URL after an edit. The builder publishes its own handler through
  `live-surfaces.ts` (`useRegisterLoadTestSurface`, mounted by
  `modules/request-builder/components/LoadTestCommandSurface.tsx`), `useCommandSurfaces` merges
  what is registered, and the command is `available` exactly while that contribution stands - so
  it is absent rather than inert while no builder is on screen, and closing the tab removes it.
  Nothing about the load test moves: the single-active-run policy, the ceilings check and
  `LoadTestConfigDialog` all stay in the builder.

The rejected alternative is worth naming, because it is the tempting one: reading the draft out
of the provider from outside it, or recomposing the payload inside the command, would be a second
copy of `buildExecBody` and of the run policy - the "hand-rolled copy of a primitive" defect this
registry exists to remove.

The channel is deliberately **one slot with one contributor**, not a registry of arbitrary named
surfaces. A second feature with the same live-draft problem (a "Send request" command has it)
joins that file as a second slot rather than inventing a second channel - but not before it
exists.

Consumers: `modules/palette/sources/commandItems.ts` (the Commands and Settings groups) and
`hooks/useMenuActions.ts` (Preferences… → `open-settings`). `lib/commands/registry.test.ts` walks
the roster and asserts every entry says something and that the settings roster still covers both
catalogues; `modules/request-builder/load-test-command-surface.test.tsx` holds the live channel to
handing over the request *as edited*, and to clearing itself on unmount.

## Toaster (`components/shared/Toaster.tsx`)

Mounted once by `App.tsx`. Renders the queue in `stores/toast-store.ts` through
the shadcn/Radix primitive in `components/ui/toast.tsx`, which owns the dismiss
timer, pausing on hover / focus / window blur, swipe-to-dismiss, and the
`data-state` the exit animation keys off. `F8` moves focus into the stack.

Toasts are the app's **single** channel for reporting the outcome of an action
the user took, including save failures (see `save-store.failSave`). Four
variants - `info`, `success`, `warning`, `error` - each carried by an icon and a
left rail rather than colour alone; tokens and durations in
`docs/design-system.md` -> Toasts.

## Stop Run Button (`components/shared/StopRunButton.tsx`)

"Stop the run that is happening right now", in the one treatment, for the two
places a run can be cancelled: the load dashboard header and the collection-run
tab. A primitive rather than markup each view repeats, because the treatment is
not a `Button` variant - a destructive *outline* over `ghost`, which no variant
paints, plus the in-flight swap to a spinner and "Stopping…". The label is
`destructive-text`, never the bare `destructive` fill.

The caller owns the request and the failure path: both call sites `await
apiService.stopRun(runId)` and, on failure, raise an **error toast with a Try
again action** rather than a Callout - the run is still generating work, so the
retry is the reason for saying anything.

## Sample Retention Note (`components/shared/SampleRetentionNote.tsx`)

One sentence, wherever a sampled set is displayed: how many records the run's
bounded stores displaced, and that what is on screen is drawn uniformly from
the whole run rather than its opening. Three surfaces show such a set - the
dashboard's Sampled Requests and Test Validation cards, and the history Samples
tab - so the wording lives here once instead of being written out three times.

Renders nothing when the run displaced nothing, and nothing when the run
reported no counts at all (an older summary): "nothing was dropped" and "we
cannot tell" are both worse as prose than as absence. Built on `Callout`
(`severity="info"`) rather than a hand-rolled muted row.

## Threshold Verdict (`components/shared/ThresholdVerdict.tsx`)

The run's verdict against the pass/fail budgets it declared
(`RunReport.thresholdValidation`): one row per budget - the limit, what the run
measured, and whether it met it - under a Passed/Failed header. Two surfaces
show it, the dashboard's report view and the history detail's Overview, so it
lives here once.

It is the **aggregate** counterpart to the Test Validation card beside it: a
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

## Capacity Summary (`components/shared/CapacitySummary.tsx`)

What a `mode: "capacity"` run's adaptive search found (`RunReport.capacity`):
the highest concurrency the target held inside its latency budget, the level it
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
  at a concurrency it never reached.

A level the search re-measured after one bad window appears **twice** in the
table, at the same concurrency; that repeat is the audit trail doing its job,
so the rows are keyed by index rather than by level. A `stopReason` this build
has no words for renders under its raw key, as `ThresholdVerdict` does with an
unknown metric.

## Captured Data Warning (`components/shared/CapturedDataWarning.tsx`)

Wherever a run's captured response exchanges are on screen: the run stored those
responses **verbatim**, headers included, so anything credential-shaped the
server sent is stored with them, and it is deleted when the run is
(`maxRunsRetained` is its expiry).

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

## Non-Loopback Badge (`components/shared/NonLoopbackBadge.tsx`)

"Reachable on `<bind>`", wherever a local service bound past loopback is named. The engine already
refused to bind wide without an explicit `confirmNonLoopback`; this is the standing reminder that the
confirmation was given. One component rather than the same chip twice: the Services drawer and the
inbox tab both render it, and as two copies they had drifted to two different wordings for one fact
(issue #556). `variant="chip"` per the Badge rule - any other variant keeps its own `hover:bg-*`,
which `cn()` does not replace, so the warning fill would turn the accent colour under the pointer.

## Shared Response Viewer (`components/shared/response-viewer/`)

Response-rendering primitives reused outside the request builder (e.g. history detail):

- `UnifiedResponseViewer.tsx` - top-level response view for stored runs. Its **Events** tab appears only when the caller passes an `events` node - a load run's captured stream (issue #657) - because almost every sampled row is not a stream, and a permanent tab reading "not an event stream" would be noise on all of them
- `ResponseBody.tsx` - body rendering (JSON/text/HTML/XML)
- `ResponseEvents.tsx` - the Events timeline (issue #574). It lived under `request-builder/components/ResponseViewer/` until a second surface needed it: a load run's sampled stream, whose events the engine parses back out of the stored body and serves on `GET /runs/:id/samples`. Three sources now feed one list - the live relay, a restored design trace, and a captured load sample - and the truncation disclosures (`eventsTruncated`, per-event `dataTruncated`) are stated once for all three
- `CapturedResponseNotice.tsx` - what a captured load-run response is *not*: truncated at `maxSampleBodyBytes`, dropped once the run's `maxSampleBytes` budget was spent, or binary and therefore stored by size and type. All three are invisible in the bytes - a truncated body looks malformed, a dropped one looks empty - so the difference is stated rather than left to be inferred
- `HeadersViewer.tsx` - the headers family, three variants in one file: the collapsible table, `CompactHeadersViewer` (same content on a sunken slab, for panes with no room for a table), and `ResponseHeadersPanel` (the Headers *tab* - request collapsed above response open, with the empty state `HeadersViewer` alone cannot give)
- `StatusCodeBadge.tsx` - the status chip
- `ResponseStatusBar.tsx` - status chip + elapsed time + payload size
- `ResponseActions.tsx` - the copy/download pair
- `tab-trigger.ts` - `RESPONSE_TAB_TRIGGER`, the underline-on-active class
- `phase-tips.ts` - `PHASE_TIPS`, the five per-phase timing tooltips (DNS -> Connect -> TLS -> TTFB -> Download), shared so every renderer of those numbers reads one string
- `timing-phases.ts` - `TIMING_PHASES`, the same five phases as one descriptor list (label, hue, tooltip, and the trace/average field each reads), plus the `phasesFromTrace` / `phasesFromAverages` selectors
- `TimingPhaseTiles.tsx` - the dense tile grid (one labelled box per phase), rendered by both sampled-exchange views
- `SampledExchange.tsx` - the sampled-exchange shell: summary row, expansion, error block and timing tiles

> **One shell, two sample lists.** The dashboard's live sample list and the
> history detail's stored one show the same thing - a sampled HTTP exchange you
> can expand - and were two components. #60 gave them the same per-concern
> primitives, which moved the drift up into the shells rather than removing it:
> each still owned its summary row, its expansion chrome and its section order,
> so a spacing or empty-state fix to one did not reach the other. By the time
> they were merged the rows differed in almost everything that is not data - one
> chevron and one hand-drawn CSS triangle, two different icon sets, and a
> slow-request state on only one side.
>
> `SampledExchange` is **presentational over already-shaped data**: a status
> code, a latency, a pre-resolved phase list. Expansion stays the parent's
> state, as it already was on the history side - the dashboard holds a `Set` of
> open indices, the history detail a single one. Sections that genuinely differ
> arrive as slots (`details` before the timing tiles, `children` after), not as
> boolean flags; the callers keep their own chrome (the history card's
> outcome-tinted border) and their own timestamp formatting, because a live row
> placing a sample inside a seconds-old run wants milliseconds where a stored
> row dating a run wants the day.
>
> Guarded by `sampled-exchange-adoption.test.tsx` (the shell is replaced with a
> sentinel, so a view that hand-rolls a row again fails) and
> `SampledExchange.test.tsx` (the shell's own behaviour).

> **One list, five renderers.** The five network phases are drawn by the
> request-builder's `ResponseTimingTab` (timeline + legend), the dashboard's
> run-level averages card and per-sample tiles, the dashboard's
> `charts/TimingWaterfall`, and the history `SampleRequestCard`. Each used to
> declare its own copy of the list, so adding a phase meant finding all five and
> nothing pointed you at the other four. Two had already drifted: the waterfall
> painted TTFB with `--primary` - an accent-tracking token the design system
> forbids for a chart series, and the very bug `ResponseTimingTab`'s header
> comment describes fixing in its own copy - and carried private tooltip strings
> that `phase-tips.ts` existed to replace.
>
> Add a phase to `TIMING_PHASES` and all five pick it up.
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
  statements under one empty state.
- `types.ts` - `AuthFieldsProps`, `AuthTextInput`, `EditableAuth`.

What stays with each host: the mode picker (only the request offers `inherit`),
the collection's per-mode inheritance hints, and the "stored but not editable"
warning for `digest`/`aws`/`ntlm` - modes the engine cannot resolve, which both
editors surface rather than collapse to "none". `AuthFields` renders nothing for
them and carries their config through untouched.

Mode names and the editable list live in `constants/auth-modes.ts`
(`AUTH_MODE_LABELS`, `EDITABLE_AUTH_MODES`), which every auth surface reads -
including `AuthInheritBanner`. Four places used to name the modes independently
and had drifted; `auth-modes.test.ts` and `AuthFields/auth-editor-parity.test.tsx`
hold that line, the latter by rendering both hosts and comparing what they show.

## Shared OAuth 2.0 Form (`components/shared/OAuth2Form/`)

The reusable OAuth 2.0 auth editor, consumed by the request builder's `AuthPanel` (and structured to be host-agnostic). A barreled module like `response-viewer/` (its `index.ts` exports the public surface):

- `OAuth2Form.tsx` - grant-type select (Client Credentials / Password / Authorization Code + PKCE), per-grant fields, an advanced section (placement, prefix, audience/resource, credentials id), and the token status row. Takes an **injected `TextInput`** so the host supplies a variable-aware input; secret fields render the masked `SecretInput` instead.
- `TokenStatusRow.tsx` - cached-token status (masked token + expiry countdown, with a reveal toggle) and Get/Refresh/Clear actions. Drives interactive sign-in via `services/oauth/authorize.ts` for the Authorization Code grant. The row always renders: an incomplete config **disables** the token action and names the fields still missing (by their on-screen labels) rather than hiding the affordance. Presence only - the engine owns URL validity, and its 400 surfaces as a toast **relabelled** through `constants/oauth2-fields.ts`, so `accessTokenUrl must be an http(s) URL` reads as *Access Token URL*. The same registry supplies the form's labels for those fields, and the `AUTH_FAILED` toasts in the request builder and `DesignRunView` relabel the identical engine string. Internal to the module.
- `types.ts` - `OAuth2FormProps`, `OAuth2TextInput`.

Config resolution (`{{variables}}`), the token cache key (`services/oauth/cache-key.ts`, byte-identical to the engine), and the token queries (`queries/oauth.ts`) sit behind it.

## Shared Key/Value Editor (`components/shared/KeyValueEditor/`)

`index`, `KeyValueRow`, `FilePartCell`, `key-value.ts` - the app's key/value
table (params, headers, form fields, and a webhook inbox's canned reply
headers).

**Resolution is an input, not an ambient dependency:** the optional `variables`
prop carries the [`VariableSupport`](#variable-scope-as-a-prop-variablesupport)
scope, and with it omitted the table resolves nothing, shows no `ResolvedPeek`
and offers no `{{` autocomplete - the correct reading of a surface with no
variables. That is what lets it mount outside `RequestBuilderProvider`; before
it, `KeyValueRow` called the context hook in its body and that hook *throws*
with no provider, so every other surface hand-rolled its own rows (issue #564).

`allowFiles` (form-data only) turns each row into a text/file switch and stays
on this table rather than the caller, since only the request builder has a wire
format that can carry a file; `FilePartCell` is the value cell of a file part -
it picks a file, shows the path, and marks one an import brought in and this app
never chose. `lib/file-path.ts` holds the basename rule it shares with the
importers.

The **variables table is deliberately not a consumer.** `modules/variables/main/VariableTableEditor.tsx` keeps its own rows for the reasons recorded in [Variables](#variables-modulesvariables); the parity it must hold with this table anyway is guarded by `key-value-parity.test.tsx`, not by hand.

`key-value.ts` is the table's **row model**: `toKeyValueItems` /
`toKeyValueEntries` convert between the domain `FormFieldEntry[]` and the
UI-layer `KeyValueItem[]` (which adds the ephemeral `id` React keys need), and
`withTrailingBlank` is the one definition of the spare row at the bottom. It
moved here from `modules/request-builder/utils/` with the table (issue #567),
because a second mount site needs the same conversion and a primitive cannot
take it from a feature module. What stayed in the request builder is what no
table asks for: `toFlatHeaders` (execution-shaped) and the managed system
headers. `KeyValueItem` and `KeyValueEditorProps` live in `types/ui.ts` for the
same reason - there is deliberately **no re-export shim** in
`modules/request-builder/types.ts`, so each name has one import path.

## Shared Variable Input (`components/shared/VariableInput/`)

`index`, `EditableVariable`, `RuntimeToken` - input with
`{{variable}}` highlighting + autocomplete. Takes the same optional `variables`
scope; without one it is a plain text field, since a token would paint a name
"not defined" and open an editor with nowhere to write.

**A token has three states, and the overlay decides between them in the order
`resolveTemplate` does** - reserved namespace first, then the scopes, then the
generator table:

| Token | Painted by | Looks like |
|-------|-----------|------------|
| `{{data.email}}` - the reserved `data.*` namespace (issue #402) | `RuntimeToken` | muted or amber, depending on the declared contract - see below |
| `{{merchantId}}` - a stored variable, or a name nothing defines | `EditableVariable` | accent when it resolves, **red** when it does not; hover reads, click edits or creates |
| `{{$guid}}` - a generator | `RuntimeToken` | muted, "generated per use", no popover |

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

The same three states paint the data chips in the script panel's **"Names
mentioned:"** row (issue #604), through the same `describeDataToken` call. A `data.*` name can
never be in `allVariables` - the namespace is disjoint from the scopes - so the
chip row's `resolves ? secondary : destructive` rule read every data column as
undefined, which is the paint #592 removed from the builder. `DATA_TOKEN_TONE_CLASS`
(`lib/data-token-tone.ts`) is the one table both surfaces read, so a column the
chip calls declared is the one the token calls declared.

**The row is "Names mentioned", not "Referenced", and a `{{}}` chip is neutral**
(issue #659). The rest of the row had the same defect #604 fixed for `data.*`:
every name was painted `resolves ? secondary : destructive`, which answers a
question that only means something for a `pm.*.get()`. The engine never
interpolates script source (D16), so a green `{{base_url}}` promised a
substitution that does not happen. `referencedVariables` (`lib/referenced-variables.ts`)
now returns each name with the syntax that found it - `pm` or `template` - and
`pm` wins when a name is written both ways, because the script does read it.
Template chips are muted, spelled `{{name}}`, and carry `TEMPLATE_IN_SCRIPT_NOTE`
as their tooltip; `pm` chips keep the resolved/unresolved pair. The collection's
Pre-request and Post-request tabs (`CollectionDetail/ScriptTab`) read the same
helper and follow the same rule - they had also printed every name as `{{name}}`,
including the ones the script reads through `pm`.

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

`EditableVariable` takes the scope as a **required** prop, because a token only
renders where there is one. `RuntimeToken` serves both run-time cases - a value
produced when the request is sent rather than stored anywhere - and is one
component rather than two because they differ only in the words of the tooltip.

The namespace check comes **before** the scope lookup deliberately: `data.*` is
disjoint from the tiers, so a variable someone happens to name `data.email`
neither answers for the column nor may paint the token as though it had. Reading
the scopes first would show a resolved token carrying a value the engine will
never send. The same rule keeps the create offer out of `VariablePopover` for
these names - a variable of that name can never resolve, so offering to make one
is a dead end that leaves the token exactly as it was.

It sits beside `KeyValueEditor` rather than inside the request builder because
every row of that table renders one: a shared table reaching into a feature
module for its cell input is the same inversion one level down (issue #567).

### Variable scope as a prop (`VariableSupport`)

`VariableSupport` (in `types/ui.ts`) is the variable slice of the request-builder
context - `resolveString`, `getAllVariables`, `getVariableOrigins`,
`updateVariable`, `writableScopes` - as a plain object a caller hands in, plus
the optional `dataColumns` (the declared data contract in scope, issue #600).
`dataColumns` is optional *within* a scope rather than with it: absent means the
chain declares no contract, which is every workspace that has not opened the
Data tab.

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

`badge`, `button`, `card`, `collapsible`, `command`, `delete-confirm-dialog`, `dialog`, `dropdown-menu`, `info-chip`, `input`, `secret-input` (masked field with a reveal toggle - client secret / passwords, and the variables table's secret rows, which is where the pattern was extracted from), `kbd`, `label`, `popover`, `resizable`, `scroll-area`, `select`, `separator`, `skeleton`, `suggestion-list`, `switch`, `tabs`, `textarea`, `tooltip`, plus variable-aware inputs: `variable-autocomplete`, `variable-popover`, `variable-scope-badge`, and markdown: `markdown-view`, `markdown-editor`.

The `cva` definitions for `badge`, `button` and `toast` live in sibling
`*-variants.ts` modules and are re-exported from `components/ui/index.ts`. A
module that exports both a component and a value cannot be hot-reloaded, which
is the only reason for the split - import `badgeVariants` / `buttonVariants` /
`toastVariants` from `@/components/ui` as before.

### `info-chip`

The 14px "i" dot with a tooltip, beside a label that needs a sentence -
timing phases, chart axes, the wire/queue/total summary. It lived in
`modules/dashboard/components/shared.tsx`, where nothing outside the dashboard
could import it without a module reaching into another module, so the request
builder grew its own copy - and the copy is the one that got the `border-rule`
fix, leaving the original outline-less in dark. The border stays a prop
(default `border-border`, pass `border-rule` on a declared surface) because
`border-rule` falls back to the invisible default where no surface declares one.
`dashboard/components/shared.tsx` re-exports it so existing imports resolve.

### Markdown (`markdown-view`, `markdown-editor`)

`MarkdownView` renders a description; `MarkdownEditor` wraps it in the
click-to-edit field used by the request **Info** tab and by
`CollectionDetail/InfoTab`. Both fields stored markdown and rendered none of it
before this existed - the collection one even advertised "Markdown supported"
beside a plain textarea.

**Two rules are load-bearing, not stylistic:**

1. **`MarkdownView` never emits a navigating anchor.** The main window has no
   `will-navigate` handler, no `setWindowOpenHandler` and no CSP, and the
   preload re-runs on the new origin - so a clicked `<a href>` would hand
   `window.electronAPI` to whatever site it landed on. Descriptions arrive from
   imported Postman / Insomnia / OpenAPI files, which are third-party documents.
   Links therefore render as `<button>`, with no `href` in the DOM, and open via
   the scheme-validated `openExternalUrl` IPC. `remark-gfm` autolinks bare URLs,
   so that override covers those too. Guarded by `markdown-view.test.tsx`.
2. **`react-markdown` with the default `urlTransform`.** It builds React
   elements from an AST, so there is no `dangerouslySetInnerHTML` and no
   sanitiser to forget. Raw HTML is inert because `rehype-raw` is deliberately
   not installed. Overriding `urlTransform` disables the built-in URL sanitising
   (there is a published advisory for exactly that), so it stays on the default.

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
- **Zustand stores (`stores/`)** - tabs (`useTabsStore`: open/active/add/close/focus), layout (`useLayoutStore`: drawer open/view/width, context bar open, split mode), dashboard metrics (`useDashboardStore`), variables (`useVariablesStore`), save (`useSaveStore`), engine connection, session (active environment), history filters, import-modal open-state.
- **TanStack Query (`queries/`)** - server state: collections, requests, runs, environments, globals, health, script completions, OAuth 2.0 token status; mutations for create/update/delete (and OAuth token fetch/clear).

## Component Communication

- **Props / callbacks** - parent↔child.
- **Context** - module-local shared state (request builder).
- **Stores** - cross-module UI state + navigation.
- **Queries/mutations** - engine-backed server state.
