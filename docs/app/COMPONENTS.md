# Component Architecture

The React component structure of the Vayu app (`app/src`).

The UI is organized into two top-level trees:

- **`components/`** - app-shell layout, status, shared response rendering, and the `ui/` primitive library. Cross-cutting pieces not owned by a single feature.
- **`modules/`** - feature modules, each self-contained (its own components, and where needed `context/`, `hooks/`, `utils/`, `shared/`): `request-builder`, `collections`, `dashboard`, `history`, `variables`, `settings`, `welcome`.

State lives outside components: **Zustand** stores (`stores/`) for UI/navigation state, **TanStack Query** (`queries/`) for server state from the engine.

## Component Hierarchy

```
<App />                                  // App.tsx - mounts providers, kicks off health/prefetch queries, OS theme sync
├── <TitleBar />                         // components/layout/TitleBar.tsx - h-[38px] drag region + logo + tabs + env pill
│   ├── Logo (all platforms)
│   ├── <TabStrip />                     // Open tabs + "+" button
│   └── EnvPill + WindowControls (Linux only; Windows native overlay; macOS traffic lights)
├── <UpdateBanner />
└── <Shell />                            // components/layout/Shell.tsx - tab-centric layout with drawer + context bar
    ├── <ImportModal />                  // modules/collections/ImportModal.tsx - global overlay, open-state in a store
    ├── <Drawer />                       // components/layout/Drawer.tsx - resizable 220–480px; single left nav; switches views
    │   ├── <CollectionTree />           //   collections view (default)
    │   ├── <HistoryList />              //   history view
    │   ├── <VariablesCategoryTree />    //   variables view
    │   └── <SettingsCategoryTree />     //   settings view
    ├── main content (switched on active tab type)
    │   ├── <WelcomeScreen />            // type="welcome"     modules/welcome/
    │   ├── <RequestBuilder />           // type="request"     modules/request-builder/
    │   ├── <CollectionDetail />         // type="collection"  modules/collections/CollectionDetail/
    │   ├── <LoadTestDashboard />        // type="dashboard"   modules/dashboard/
    │   ├── <HistoryDetail />            // type="run"         modules/history/main/
    │   ├── <VariablesMain />            // type="variables"   modules/variables/main/
    │   └── <SettingsMain />             // type="settings"    modules/settings/main/ (content pane; tree is in the Drawer)
    ├── <ContextBar />                   // components/layout/ContextBar.tsx - 252px; request tabs only; push ≥1200px / overlay <1200px
    └── <Dock />                         // components/layout/Dock.tsx - drawer view switchers + engine/save status + toggles
```

## App Shell

### `App` (`App.tsx`)

Root component. Renders `<TitleBar />` over `<Shell />`. On mount it wires up app-wide concerns via hooks/queries: OS/Electron theme sync (`useElectronTheme`), engine health polling (`useHealthQuery`), and prefetching of server state (`usePrefetchCollectionsAndRequests`, `useRunsQuery`, `useScriptCompletionsQuery`).

### `TitleBar` (`components/layout/TitleBar.tsx`)

Custom window title bar (Electron frameless window, h-[38px]). Platform-specific controls:

- **All platforms:** Logo (left), `<TabStrip />` (center, flexes to fill).
- **macOS:** Native traffic light inset (~80px left); no HTML window controls.
- **Windows:** Native window overlay; no HTML controls in the bar.
- **Linux:** Custom HTML min/max/close buttons (right); `EnvPill` showing active environment.

The entire bar is marked as a drag region (`WebkitAppRegion: "drag"`) except for interactive elements, which explicitly set `no-drag`. Keep `no-drag` on the interactive elements themselves, never on a layout wrapper: the `TabStrip` wrapper flexes to fill the bar, so marking *it* `no-drag` turns all the empty space right of the last tab into a dead zone the window can't be dragged by. `TabStrip` sets `no-drag` on its own tab row for this reason.

The logo is imported as a module (`@shared/icon_png/...`), not referenced as `/icon.png`. With `base: "./"`, a root-absolute path resolves against the filesystem root under the packaged `file://` build and silently fails to load - it only appears to work in dev, where Vite serves it over HTTP.

### `TabStrip` (`components/layout/TabStrip.tsx`)

Horizontal row of open tabs plus a "+" button. Reads from `useTabsStore` (open tabs, active tab, add/close/focus methods).

- **One tab per open entity**, deduplicated per type and `entityId`. Tabs show: icon (method badge for requests, folder for collections, lightning for dashboard, etc.), label (request method + URL path / collection name / screen name).
- **Max 12 tabs** with LRU eviction when exceeding; dashboard tabs are exempt from eviction. Dirty tabs (unsaved) are skipped during eviction (autosave is the safety net).
- **Middle-click closes** a tab (browser-like).
- **No unsaved dot** - autosave ensures safety.
- **Keyboard support:** ⌘1–9 jump to tab; displayed via dock shortcuts.

### `Shell` (`components/layout/Shell.tsx`)

Main layout: tab-centric with resizable drawer, split/overlay context bar, and docked footer.

- **One uniform layout for every tab** - `Drawer` (left) + main content + `ContextBar` (right). No tab type takes over the row. This is deliberate: the Dock's drawer switchers always have a Drawer to act on, so they can never be dead. (Settings used to full-take-over and suppress the Drawer, which left those buttons doing nothing while Settings was open.)
- **Left navigation is always the Drawer.** Every main view that needs a category/entity list uses the shared Drawer for it - never its own left rail. `SettingsMain` and `VariablesMain` are pure content panes; their category trees live in the Drawer (`settings` / `variables` views). Follow this pattern for any new view - do not add a second sidebar inside the main area.
- **Keyboard handlers:** ⌘S (save), ⌘W (close tab), ⌘B (toggle drawer), ⇧⌘E/H/U (drawer views), ⌘I (toggle context bar), ⌘, (open settings tab).
- **Drawer:** toggles visibility via `toggleDrawer()` (state in `useLayoutStore`); always resizable 220–480px.
- **Content routing:** switches main area based on `activeTab.type` (welcome | request | collection | dashboard | run | variables | settings). Default is `WelcomeScreen`.
- **Drawer-view sync:** an effect points the Drawer at the view matching the active tab - `variables`→variables, `settings`→settings, `request`/`collection`→collections - and opens it.
- **ContextBar mode:** picks "push" (≥1200px width) or "overlay" based on window width. Context bar is request-tab–only.
- **`<ImportModal />`** mounted once as a global overlay; visibility in a dedicated store.

### `Drawer` (`components/layout/Drawer.tsx`)

Resizable sidebar (220–480px default, per view). The single left navigation for the whole app - one of four views per `useLayoutStore.drawerView`:

- **`collections`** - `CollectionTree` (hierarchical collections + requests).
- **`history`** - `HistoryList` (past runs, filtered/sorted).
- **`variables`** - `VariablesCategoryTree` (variable scopes: globals, collections, environments).
- **`settings`** - `SettingsCategoryTree` (app + engine setting categories).

Both `variables` and `settings` follow the same nav/content split: the tree lives here in the Drawer, the editor is the corresponding tab (`VariablesMain` / `SettingsMain`), and selecting a category sets the shared store selection **and** opens/focuses that tab.

Resize handle on the right edge (double-click resets to defaults). Visibility toggled by `toggleDrawer()` or ⌘B.

### `ContextBar` (`components/layout/ContextBar.tsx`)

252px panel (fixed width, request-tab–only) showing variables in scope for the active request.

- **Push mode** (≥1200px): adjacent to main content, takes layout space.
- **Overlay mode** (<1200px): floats over main content, top-right (absolute positioned, shadow, z-10).
- **Toggle:** ⌘I or Dock button. Visibility in `useLayoutStore`.
- **Content:** resolves the active request's variables (global + collection-scoped + environment) via `useVariableResolver`; displays `{{name}}` : `value` pairs (secrets masked).

### `Dock` (`components/layout/Dock.tsx`)

Footer bar (h-8, shrink-0). Horizontal layout:

- **Left - drawer switchers:** buttons for Collections (⇧⌘E), History (⇧⌘H), Variables (⇧⌘U), Settings (⌘,). Each activates its Drawer view; active state highlights when the drawer is open on that view. Settings sits here too because it is now a Drawer view like the rest.
- **Middle - ambient status:** engine connection status (green dot + text if connected), save status (Saving… / Saved / error), app version.
- **Right - toggles:** Context bar toggle (⌘I).

## Request Builder (`modules/request-builder/`)

The request editor. Entry: `modules/request-builder/index.tsx`.

**Container (`index.tsx`)** - fetches the selected request (`useRequestQuery(selectedRequestId)`), maps the stored `Request` (discriminated-union `body`/`auth`) into flat UI state, and provides callbacks through `RequestBuilderProvider` to `RequestBuilderLayout`. Responsibilities:

- **Execute:** resolves `{{variables}}` in URL/headers/body, injects per-request system headers (`X-Request-ID`, `X-Vayu-Version`), resolves auth, composes scripts, and calls the engine via `useEngine()`.
- **Auth inheritance:** for `auth.mode === "inherit"` it walks the collection ancestor chain **leaf-first** (`useCollectionAncestors`) and uses the first non-`none` auth.
- **Script composition:** concatenates ancestor collection pre/post scripts **root→leaf**, then the request's own script.
- **Load test:** opens `LoadTestConfigDialog`, then starts the run (`apiService.startLoadTest` + `loadTestService.startMonitoring`) and navigates to the dashboard.
- **Save:** rebuilds the `RequestBody`/`RequestAuth` unions from flat UI state via `useUpdateRequestMutation`.

**Structure:**

| Path | Role |
|---|---|
| `context/RequestBuilderProvider.tsx`, `context/RequestBuilderContext.tsx` | Local request-editing state + the execute/save/load-test callbacks |
| `components/RequestBuilderLayout.tsx` | Resizable vertical layout composing UrlBar / RequestTabs / ResponseViewer |
| `components/UrlBar/` | `index`, `MethodSelector`, `UrlInput` - method dropdown, URL input (variable highlighting), Send + Load Test buttons. Pasting a curl/wget command into `UrlInput` auto-imports it (see note below) |
| `components/RequestTabs/` | `index` + `panels/`: `ParamsPanel`, `HeadersPanel`, `BodyPanel`, `AuthPanel`, `AuthInheritBanner`, `PreScriptPanel`, `TestScriptPanel`, `InheritedScriptsNotice`, `SettingsPanel`. `AuthPanel` supports None / Bearer / Basic / API Key / **OAuth 2.0** (via the shared [`OAuth2Form`](#shared-oauth-20-form)). `PreScriptPanel` and `TestScriptPanel` each render `InheritedScriptsNotice` (the script equivalent of `AuthInheritBanner`) to name which ancestor collections contribute a pre-request or test script; it accepts an optional `entries` prop so a stored-run view can supply parts directly instead of reading the live chain. `SettingsPanel` holds the per-request redirect policy (**Follow redirects** + **Maximum redirects**); the tab strip badges it via `isRedirectPolicyNonDefault` (in `utils/request-state`) only when the request departs from the engine defaults |
| `components/ResponseViewer/` | `index`, `ResponseCookies`, `ResponseTimingTab`, `TestResults`, `ConsoleOutput`, `RawRequestResponse`, `ClientErrorView` (status bar, actions and the Headers tab now come from `shared/response-viewer/`) |
| `components/RequestDescription.tsx` | Editable request description |
| `components/LoadTestConfigDialog.tsx` | Load-test configuration dialog (mode, duration, RPS, concurrency, …). Renders `OAuth2LoadTestGuard` when the request's effective auth is OAuth 2.0 |
| `components/OAuth2LoadTestGuard.tsx`, `components/oauth2-load-test-coverage.ts` | Warns when a duration-based load test would outlive its access token (the engine acquires a token once per run, no mid-run refresh): offers **Refresh** when a fresh token would cover the run, or **blocks Start** (with a "Start anyway" override) when even a fresh token can't. The pure coverage decision lives in `oauth2-load-test-coverage.ts` |
| `shared/KeyValueEditor/` | `index`, `KeyValueRow` - reusable key/value table (params, headers, form fields) |
| `shared/VariableInput/` | `index`, `EditableVariable` - input with `{{variable}}` highlighting + autocomplete |
| `hooks/`, `utils/` | Module hooks; `utils/key-value` (flat↔entry conversions), `utils/id` |

> **cURL / wget import:** pasting a `curl` or `wget` command into the URL field auto-populates the whole request (method, URL, params, headers, body, auth). Auth maps `-u`/`--user` (and wget `--http-user`/`--http-password`) to Basic, and curl `--oauth2-bearer` to Bearer; an `Authorization` header is left as a raw header (to preserve `{{variables}}`). Form-shaped `-d`/`--data` without an explicit `Content-Type` maps to `x-www-form-urlencoded` rows (curl's on-the-wire default), while a raw JSON/text blob stays a text body. Detection + parsing live in `services/curl/` (`tokenize.ts` shell tokenizer + `parseCurl.ts`), kept separate from the collection `importers/` pipeline since this targets the active request. The paste is a request-shape replacement - identity (`id`, `name`, `collectionId`) and scripts are preserved; file references (`-d @file`, `-F field=@file`, `--post-file`) are skipped since they can't be read from pasted text. Non-command pastes fall through to normal input.

> **Body tabs** support `none` / `json` / `text` / `graphql` / `form-data` / `x-www-form-urlencoded`. The `graphql` mode renders a split resizable editor: a **Query** pane (Monaco `graphql` language with diagnostics, autocomplete, hover, and formatting) and a **Variables** pane (Monaco `json` with schema-derived validation). **Scripts** are two separate panels - pre-request and test - not a single tab.

## GraphQL Library (`lib/graphql/`)

Shared, Monaco-independent modules that power the GraphQL body mode.

| File | Role |
|---|---|
| `diagnostics.ts` | Pure (Monaco-free) diagnostic computation - syntax check via `graphql.parse` when no schema is available; full field/type validation via `graphql-language-service.getDiagnostics` when a schema is loaded. Returns 1-based `GqlMarker[]` matching Monaco's `IMarkerData` shape. |
| `introspect.ts` | Fetches a `GraphQLSchema` by routing the standard introspection query through the engine (`apiService.executeRequest`), avoiding CORS and reusing the request's auth headers. |
| `schema-cache.ts` | Zustand store (`useSchemaCache`) keyed by resolved endpoint URL. States: `idle → loading → ready \| error`. `ensureSchema` skips URLs already attempted; `refreshSchema` forces a re-fetch. Exposes `getActiveSchema()` and `getActiveStatus()` for Monaco providers. |
| `language-providers.ts` | Registers Monaco language providers for the `graphql` language: completion (fields, types, directives), hover type info, debounced inline diagnostics (re-runs on content change and on schema cache updates), and document formatting (`print(parse(...))`). Call once after `loader.config`. |
| `variables-schema.ts` | Derives a JSON Schema from the query's `$variable` definitions + the introspected schema via `getVariablesJSONSchema`, then applies it to the variables editor through `monaco.json.jsonDefaults` so variable values are validated and autocompleted. |

`lib/monaco-setup.ts` (sibling of `lib/graphql/`) configures `@monaco-editor/react` to use the locally bundled `monaco-editor` instead of the jsDelivr CDN, wires language web workers via Vite `?worker` imports, and calls `registerGraphqlProviders`. It is a side-effecting module imported once at the top of `main.tsx`.

## Collections (`modules/collections/`)

| Component | Role |
|---|---|
| `CollectionTree.tsx` | Hierarchical tree of collections + requests in the sidebar; expandable folders, context menus, method badges. State from `useCollectionsStore` + `useCollectionsQuery`/`useRequestsQuery` |
| `CollectionItem.tsx` | A collection (folder) row |
| `RequestItem.tsx` | A request row (method badge, click → open in RequestBuilder, context menu) |
| `ImportModal.tsx` | Import collections from file/URL/paste (Postman / Insomnia / OpenAPI). Mounted globally in `Shell`; open-state in a dedicated store. See [import-collections/](./import-collections/README.md) for the parser pipeline |
| `CollectionDetail/` | The collection editor screen (see below) |

### `CollectionDetail/` (screen `"collection-detail"`)

Tab shell reached via `navigationStore.navigateToCollection(id)`. Header shows name + request count; five tabs:

| Tab | Component | Notes |
|---|---|---|
| Info | `InfoTab.tsx` | Name, description, request count |
| Auth | `AuthTab.tsx` | Collection-level auth (concrete; never `inherit`) |
| Pre-request | `ScriptTab.tsx` (`kind="pre"`) | Collection pre-request script |
| Post-request | `ScriptTab.tsx` (`kind="post"`) | Collection post-request script |
| Variables | `VariablesTab.tsx` | Collection-scoped variables (count badge) |

`InheritanceChain.tsx` and `shared.tsx` are helpers used by these tabs (e.g. visualizing the auth/variable inheritance chain).

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
| `RequestResponseView.tsx` | Status-code distribution, error breakdown, timing breakdown, sampled requests |
| `shared.tsx`, `tooltips.tsx` | Shared bits (Eyebrow/InfoChip) + centralized InfoChip wording |

**`hero/` - mode-adaptive hero cards** (`HeroRow.tsx` selects per mode, all built on `HeroCardShell.tsx`): `RateFidelityCard`, `DroppedRequestsCard`, `AchievedThroughputCard`, `ThroughputCard`, `ThroughputTwinCard`, `CurrentConcurrencyCard`, `ConcurrencyUtilCard`, `SaturationCard`, `ProgressCard`, `ErrorRateCard`.

**`charts/`** - all time-series, scatter, and distribution plots are centralized in **`charts/uplot/`** and built on a single Canvas primitive, `UPlotChart.tsx` (uPlot). Import them from `charts/uplot/index.ts` so live and history render identical components: `LatencyPercentilesChart` (p50/p95/p99), `LatencyBreakdownChart` (wire/queue-wait split), `RequestRateChart` (configured-vs-achieved throughput), `ConnectionsChart`, `ErrorRateChart` (from `TimeSeriesCharts.tsx`); `ResponseTimeVsConcurrencyChart` (ramp_up capacity discovery w/ breakpoint marker) and `HdrPercentileChart` (from `ScatterAndDistribution.tsx`); and `StatusCodesOverTimeChart` (stacked). Supporting modules in the same folder: `buildData.ts` (series → uPlot data), `chartFocus.ts` + `syncKeys.ts` (scatter↔time cross-highlight/cursor sync), `plugins.ts`, `formatters.ts`, and `uplotTheme.ts` (CSS-token-driven theming). Outside `uplot/`, `HdrPercentilePlot.tsx` is now just the loading skeleton (`SkeletonHdrPlot`), and `TimingWaterfall.tsx` remains an SVG chart.

**`stats/`** - `ModeStatsRow.tsx` routes to the per-mode Row 4 stat set; `ModeStatCards.tsx`, `StatCard.tsx`.

**`hooks/`** - `useMode.ts` (run-config → mode discriminator).

**`utils/`** - `metricsTransforms.ts` (SSE history → chart series), `reportToDerived.ts` (stored `RunReport` → the same `DashboardDerived` shape, so history reuses the live components), `computeBreakpoint.ts`, `computeEta.ts`, `chartGeometry.ts`. `types.ts` holds the shared dashboard types (`DashboardDerived`, etc.).

## History (`modules/history/`)

Past runs (single executions and load tests), split into a sidebar list and a main detail view.

**Sidebar (`sidebar/`):** `HistoryList.tsx` (filter/sort all runs; state from `useHistoryStore`, data from `useRunsQuery`) and `RunItem.tsx` (one run row - method badge, status, relative time, URL, load-test chips).

**Detail (`main/`):** `HistoryDetail.tsx` routes by run type to `DesignRunView.tsx` (a single request execution, opened as an editable copy) or `LoadTestDetail.tsx` (load-test report).

`HistoryDetail` fetches the **run** (`useRunQuery`) and asks for the report only when the run is a load run. `GET /runs/:id/report` is a load-test aggregate: against a design run its percentiles all come from one sample and `metadata.configuration` is absent, so it cannot say what a design run's auth, scripts or redirect settings were. `GET /runs/:id` can, and for a design run it also carries the stored exchange. The header shows the run's identity, type and status but **not** its URL - the builder below renders its own URL bar, and two stacked read as a bug.

`DesignRunView.tsx` renders `RequestBuilderProvider` + `RequestBuilderLayout` with starting values from `design-run-seed.ts` (`seedFromRun`), the stored exchange as `initialResponse`, and the run's recorded collection script parts as `inheritedPreScripts` / `inheritedPostScripts`. It **holds the pane until `useRequestQuery` settles**, and tells a genuine deletion from a transport failure before seeding: `seedFromRun` reads a falsy live request as "deleted", so a query in flight, a deletion and an unreachable engine all look alike unless kept apart. The provider re-seeds only on a change of `initialRequest.id` - null for every detached copy - so an early or wrong seed would stick. Loading holds the pane; a genuine deletion (the `RequestNotFoundError` sentinel from `useRequestQuery`, matched via `isRequestNotFound` not a message string) seeds the orphan copy that replays the recorded wire headers; any other settled error is a transport failure and renders `ErrorState` with a retry rather than guessing a copy. The run's recorded auth **mode** (`seed.recordedAuthMode`, all that survives storage) is shown read-only beside the copy, so a user can see when the request's current auth differs from what the run sent. A run recorded before script parts existed passes its one glued string as `legacyPreScript` / `legacyPostScript`; `LegacyScriptNotice` shows it whole with a note that its parts cannot be separated, and the replay sends it as a single request-origin part. **The copy is detached** by two independent gates - `id: null` and no `onSave` - so editing it cannot rewrite the saved request. Sending again replays the recorded collection parts unchanged plus the edited request part, under the same `requestId`. `SaveRunToRequestDialog.tsx` + `save-run-to-request.ts` write chosen values back behind a confirm; they never write auth (only the mode survives storage) and never write scripts for a run stored before script parts existed.

`LoadTestDetail` is **mode-aware** (header strip + tabs adapt to the run's mode, derived via `reportToDerived` → the same `DashboardDerived` shape the live dashboard uses) and composes the tabbed report under `main/components/`:

| Component | Role |
|---|---|
| `OverviewTab.tsx` | Summary - renders the dashboard's mode-adaptive `HeroRow` + `ModeStatsRow`; the Rate-Control card is gated to `constant_rps` |
| `PerformanceTab.tsx` | Latency/throughput detail |
| `SamplesTab.tsx`, `SampleRequestCard.tsx` | Sampled request/response pairs |
| `TimingBreakdown.tsx` | DNS/connect/TLS/first-byte/download breakdown |
| `LatencyMetric.tsx`, `HistoricalChartsSection.tsx` | Metric cards + historical charts |

> History detail reuses the live dashboard's `hero/`, `charts/`, and `stats/` components by feeding them a `DashboardDerived` built from the stored report (`reportToDerived`), so live and historical views stay visually consistent.

## Variables (`modules/variables/`)

- **Sidebar (`sidebar/VariablesCategoryTree.tsx`)** - tree of variable scopes (globals, collections, environments); receives `collections` + `environments` from the Sidebar.
- **Main (`main/`)** - `VariablesMain.tsx` (screen `"variables"`) hosts `VariableTableEditor.tsx`, the table editor for the selected scope, including the active-environment selector.

## Settings (`modules/settings/`)

Same nav/content split as Variables: the category tree renders in the **Drawer** (`settings` view), not inside the settings tab. Selecting a category sets `useSettingsStore.selectedCategory` **and** opens the settings tab, so `SettingsMain` shows that panel. There is no `SettingsLayout` two-pane wrapper anymore - the Drawer is the left pane.

- **Sidebar (`sidebar/SettingsCategoryTree.tsx`)** - settings category navigation; rendered by the Drawer.
- **Main (`main/`)** - `SettingsMain.tsx` (screen `"settings"`) hosts the app-settings category panels under `main/panels/`: `AppearancePanel.tsx`, `DashboardPanel.tsx`, `GeneralPanel.tsx`, and `EditorPanel.tsx`, plus the shared `ClientSettingsPanel.tsx` wrapper, `FontPicker.tsx`, and `SettingControls.tsx` primitives. `app-panels.ts` is the panel registry/metadata. (The former monolithic `UISettingsPanel.tsx` was split into these panels in PR #55.)

## Welcome (`modules/welcome/`)

Vayu's new-tab surface - rendered for the `welcome` tab (opened by TabStrip's `+`), when no tab is open, and for a request tab with no entity.

It is **not** a resume screen: `openTabs`/`activeTabId` are persisted and restored, so returning users land back on their own tabs. Its job is to start something new. Keep marketing content off it - a feature pitch and static perf claims were removed for exactly that reason. Anything already visible in the Collections sidebar or History drawer is a duplicate and does not belong here either.

- `WelcomeScreen.tsx` - container: queries, `handleNewRequest`, picks the state. Holds on `isLoading` so the first-run screen never flashes at a returning user.
- `EmptyState.tsx` - fresh workspace. Import leads (people arrive carrying Postman/Insomnia/OpenAPI collections). The only state with branding.
- `Launcher.tsx` - populated. Action row, recent runs, workspace counts. No branding; the logo is in the title bar.
- `components/` - `ActionTile`, `RecentRuns`, `FooterLinks`.

Doc links go through `window.electronAPI.openAppLink(key)`, a keyed IPC channel - the renderer cannot open arbitrary URLs, and a plain `<a target="_blank">` would spawn an unmanaged Electron window.

Design rationale: `app/src/modules/welcome/README.md`

## Shared Response Viewer (`components/shared/response-viewer/`)

Response-rendering primitives reused outside the request builder (e.g. history detail):

- `UnifiedResponseViewer.tsx` - top-level response view for stored runs
- `ResponseBody.tsx` - body rendering (JSON/text/HTML/XML)
- `HeadersViewer.tsx` - response headers (plus `CompactHeadersViewer`)
- `StatusCodeBadge.tsx` - the status chip
- `ResponseStatusBar.tsx` - status chip + elapsed time + payload size
- `ResponseActions.tsx` - the copy/download pair
- `ResponseHeadersPanel.tsx` - the Headers tab body
- `tab-trigger.ts` - `RESPONSE_TAB_TRIGGER`, the underline-on-active class
- `phase-tips.ts` - `PHASE_TIPS`, the five per-phase timing tooltips (DNS -> Connect -> TLS -> TTFB -> Download), shared so every renderer of those numbers reads one string

> **Two shells, shared parts.** The request builder has its own richer
> `components/ResponseViewer/` (console output, test results, cookies, timing,
> raw request/response, client-error view) fed from live context;
> `UnifiedResponseViewer` shows three tabs from a stored run and adds a compact
> mode. They are **not** merged, and should not be: seven tabs against three,
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

## Shared OAuth 2.0 Form (`components/shared/OAuth2Form/`)

The reusable OAuth 2.0 auth editor, consumed by the request builder's `AuthPanel` (and structured to be host-agnostic). A barreled module like `response-viewer/` (its `index.ts` exports the public surface):

- `OAuth2Form.tsx` - grant-type select (Client Credentials / Password / Authorization Code + PKCE), per-grant fields, an advanced section (placement, prefix, audience/resource, credentials id), and the token status row. Takes an **injected `TextInput`** so the host supplies a variable-aware input; secret fields render the masked `SecretInput` instead.
- `TokenStatusRow.tsx` - cached-token status (masked token + expiry countdown, with a reveal toggle) and Get/Refresh/Clear actions. Drives interactive sign-in via `services/oauth/authorize.ts` for the Authorization Code grant. Internal to the module.
- `types.ts` - `OAuth2FormProps`, `OAuth2TextInput`.

Config resolution (`{{variables}}`), the token cache key (`services/oauth/cache-key.ts`, byte-identical to the engine), and the token queries (`queries/oauth.ts`) sit behind it.

## UI Primitives (`components/ui/`)

Primitives built on Radix UI + cmdk:

`badge`, `button`, `card`, `collapsible`, `command`, `delete-confirm-dialog`, `dialog`, `dropdown-menu`, `input`, `secret-input` (masked field with a reveal toggle - used for client secret / passwords), `kbd`, `label`, `popover`, `resizable`, `scroll-area`, `select`, `separator`, `skeleton`, `switch`, `tabs`, `textarea`, `tooltip`, plus variable-aware inputs: `variable-autocomplete`, `variable-popover`, `variable-scope-badge`.

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
