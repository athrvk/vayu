# Component Architecture

The React component structure of the Vayu app (`app/src`).

The UI is organized into two top-level trees:

- **`components/`** — app-shell layout, status, shared response rendering, and the `ui/` primitive library. Cross-cutting pieces not owned by a single feature.
- **`modules/`** — feature modules, each self-contained (its own components, and where needed `context/`, `hooks/`, `utils/`, `shared/`): `request-builder`, `collections`, `dashboard`, `history`, `variables`, `settings`, `welcome`.

State lives outside components: **Zustand** stores (`stores/`) for UI/navigation state, **TanStack Query** (`queries/`) for server state from the engine.

## Component Hierarchy

```
<App />                                  // App.tsx — mounts providers, kicks off health/prefetch queries, OS theme sync
├── <TitleBar />                         // components/layout/TitleBar.tsx — h-[38px] drag region + logo + tabs + env pill
│   ├── Logo (all platforms)
│   ├── <TabStrip />                     // Open tabs + "+" button
│   └── EnvPill + WindowControls (Linux only; Windows native overlay; macOS traffic lights)
├── <UpdateBanner />
└── <Shell />                            // components/layout/Shell.tsx — tab-centric layout with drawer + context bar
    ├── <ImportModal />                  // modules/collections/ImportModal.tsx — global overlay, open-state in a store
    ├── <Drawer />                       // components/layout/Drawer.tsx — resizable 220–480px; switches between views
    │   ├── <CollectionTree />           //   collections view (default)
    │   ├── <HistoryList />              //   history view
    │   └── <VariablesCategoryTree />    //   variables view
    ├── main content (switched on active tab type)
    │   ├── <WelcomeScreen />            // type="welcome"     modules/welcome/
    │   ├── <RequestBuilder />           // type="request"     modules/request-builder/
    │   ├── <CollectionDetail />         // type="collection"  modules/collections/CollectionDetail/
    │   ├── <LoadTestDashboard />        // type="dashboard"   modules/dashboard/
    │   ├── <HistoryDetail />            // type="run"         modules/history/main/
    │   ├── <VariablesMain />            // type="variables"   modules/variables/main/
    │   └── <SettingsMain />             // type="settings"    modules/settings/main/ (with SettingsCategoryTree sidebar)
    ├── <ContextBar />                   // components/layout/ContextBar.tsx — 252px; request tabs only; push ≥1200px / overlay <1200px
    └── <Dock />                         // components/layout/Dock.tsx — drawer view switchers + engine/save status + toggles
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

The entire bar is marked as a drag region (`WebkitAppRegion: "drag"`) except for interactive elements, which explicitly set `no-drag`.

### `TabStrip` (`components/layout/TabStrip.tsx`)

Horizontal row of open tabs plus a "+" button. Reads from `useTabsStore` (open tabs, active tab, add/close/focus methods).

- **One tab per open entity**, deduplicated per type and `entityId`. Tabs show: icon (method badge for requests, folder for collections, lightning for dashboard, etc.), label (request method + URL path / collection name / screen name).
- **Max 12 tabs** with LRU eviction when exceeding; dashboard tabs are exempt from eviction. Dirty tabs (unsaved) are skipped during eviction (autosave is the safety net).
- **Middle-click closes** a tab (browser-like).
- **No unsaved dot** — autosave ensures safety.
- **Keyboard support:** ⌘1–9 jump to tab; displayed via dock shortcuts.

### `Shell` (`components/layout/Shell.tsx`)

Main layout: tab-centric with resizable drawer, split/overlay context bar, and docked footer.

- **Keyboard handlers:** mounts global key listeners for ⌘S (save), ⌘W (close tab), ⌘B (toggle drawer), ⇧⌘E/H/U (drawer views), ⌘I (toggle context bar), ⌘, (settings).
- **Drawer:** toggles visibility via `toggleDrawer()` (state in `useLayoutStore`); always resizable 220–480px.
- **Content routing:** switches main area based on `activeTab.type` (welcome | request | collection | dashboard | run | variables | settings). Renders the appropriate screen module; default is `WelcomeScreen`.
- **ContextBar mode:** picks "push" (≥1200px width) or "overlay" based on window width. Context bar is request-tab–only.
- **`<ImportModal />`** mounted once as a global overlay; visibility in a dedicated store.

### `Drawer` (`components/layout/Drawer.tsx`)

Resizable sidebar (220–480px default, per view). One of three views per `useLayoutStore.drawerView`:

- **`collections`** — `CollectionTree` (hierarchical collections + requests).
- **`history`** — `HistoryList` (past runs, filtered/sorted).
- **`variables`** — `VariablesCategoryTree` (variable scopes: globals, collections, environments).

Resize handle on the right edge (double-click resets to defaults). Visibility toggled by `toggleDrawer()` or ⌘B.

### `ContextBar` (`components/layout/ContextBar.tsx`)

252px panel (fixed width, request-tab–only) showing variables in scope for the active request.

- **Push mode** (≥1200px): adjacent to main content, takes layout space.
- **Overlay mode** (<1200px): floats over main content, top-right (absolute positioned, shadow, z-10).
- **Toggle:** ⌘I or Dock button. Visibility in `useLayoutStore`.
- **Content:** resolves the active request's variables (global + collection-scoped + environment) via `useVariableResolver`; displays `{{name}}` : `value` pairs (secrets masked).

### `Dock` (`components/layout/Dock.tsx`)

Footer bar (h-8, shrink-0). Horizontal layout:

- **Left — drawer switchers:** buttons for Collections (⇧⌘E), History (⇧⌘H), Variables (⇧⌘U). Active state highlights when drawer is open and matching view.
- **Middle — ambient status:** engine connection status (green dot + text if connected), save status (Saving… / Saved / error), app version.
- **Right — toggles:** Context bar toggle (⌘I), Settings (⌘,).

## Request Builder (`modules/request-builder/`)

The request editor. Entry: `modules/request-builder/index.tsx`.

**Container (`index.tsx`)** — fetches the selected request (`useRequestQuery(selectedRequestId)`), maps the stored `Request` (discriminated-union `body`/`auth`) into flat UI state, and provides callbacks through `RequestBuilderProvider` to `RequestBuilderLayout`. Responsibilities:

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
| `components/UrlBar/` | `index`, `MethodSelector`, `UrlInput` — method dropdown, URL input (variable highlighting), Send + Load Test buttons. Pasting a curl/wget command into `UrlInput` auto-imports it (see note below) |
| `components/RequestTabs/` | `index` + `panels/`: `ParamsPanel`, `HeadersPanel`, `BodyPanel`, `AuthPanel`, `AuthInheritBanner`, `PreScriptPanel`, `TestScriptPanel` |
| `components/ResponseViewer/` | `index`, `ResponseHeader`, `ResponseHeadersTab`, `ResponseCookies`, `TestResults`, `ConsoleOutput`, `RawRequestResponse`, `ClientErrorView` |
| `components/RequestDescription.tsx` | Editable request description |
| `components/LoadTestConfigDialog.tsx` | Load-test configuration dialog (mode, duration, RPS, concurrency, …) |
| `shared/KeyValueEditor/` | `index`, `KeyValueRow` — reusable key/value table (params, headers, form fields) |
| `shared/VariableInput/` | `index`, `EditableVariable` — input with `{{variable}}` highlighting + autocomplete |
| `hooks/`, `utils/` | Module hooks; `utils/key-value` (flat↔entry conversions), `utils/id` |

> **cURL / wget import:** pasting a `curl` or `wget` command into the URL field auto-populates the whole request (method, URL, params, headers, body, basic auth). Detection + parsing live in `services/curl/` (`tokenize.ts` shell tokenizer + `parseCurl.ts`), kept separate from the collection `importers/` pipeline since this targets the active request. The paste is a request-shape replacement — identity (`id`, `name`, `collectionId`) and scripts are preserved; file references (`-d @file`, `-F field=@file`, `--post-file`) are skipped since they can't be read from pasted text. Non-command pastes fall through to normal input.

> **Body tabs** support `none` / `json` / `text` / `graphql` / `form-data` / `x-www-form-urlencoded`. The `graphql` mode renders a split resizable editor: a **Query** pane (Monaco `graphql` language with diagnostics, autocomplete, hover, and formatting) and a **Variables** pane (Monaco `json` with schema-derived validation). **Scripts** are two separate panels — pre-request and test — not a single tab.

## GraphQL Library (`lib/graphql/`)

Shared, Monaco-independent modules that power the GraphQL body mode.

| File | Role |
|---|---|
| `diagnostics.ts` | Pure (Monaco-free) diagnostic computation — syntax check via `graphql.parse` when no schema is available; full field/type validation via `graphql-language-service.getDiagnostics` when a schema is loaded. Returns 1-based `GqlMarker[]` matching Monaco's `IMarkerData` shape. |
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

Connects to the engine SSE metrics stream (`/metrics/live/:runId`, via the load-test service / dashboard store), shows live metrics while running, and converges on the final report on completion. Stop action supported.

The dashboard is **mode-adaptive**: a `useMode()` discriminator maps the run config to one of `constant_rps` / `constant_concurrency` / `iterations` / `ramp_up`, and the hero row + stat row + charts render the surfaces appropriate to that mode. `MetricsView` is a thin orchestrator over a modular tree:

**Top-level (`components/`)**

| Component | Role |
|---|---|
| `DashboardHeader.tsx` | Title, run status, stop button |
| `RunMetadata.tsx` | Endpoint, config (mode/duration/RPS/concurrency), timing |
| `MetricsView.tsx` | Orchestrator — composes the hero row, stat row, and charts per mode |
| `RequestResponseView.tsx` | Status-code distribution, error breakdown, timing breakdown, sampled requests |
| `MetricCard.tsx` | Single metric stat card |
| `shared.tsx`, `tooltips.tsx` | Shared bits (Eyebrow/InfoChip) + centralized InfoChip wording |

**`hero/` — mode-adaptive hero cards** (`HeroRow.tsx` selects per mode, all built on `HeroCardShell.tsx`): `RateFidelityCard`, `DroppedRequestsCard`, `AchievedThroughputCard`, `ThroughputCard`, `ThroughputTwinCard`, `CurrentConcurrencyCard`, `ConcurrencyUtilCard`, `SaturationCard`, `ProgressCard`, `ErrorRateCard`.

**`charts/`** (all built on the shared `TimeSeriesChart.tsx` + `utils/chartGeometry.ts`): `ThroughputOverTimeChart` (configured-vs-achieved for ramp_up), `LatencyOverTimeChart` (wire/queue-wait split), `PercentilesOverTimeChart` (p50/p95/p99), `StatusCodesOverTimeChart` (stacked), `ResponseTimeVsConcurrencyScatter` (ramp_up capacity discovery w/ breakpoint marker), `HdrPercentilePlot`, `TimingWaterfall`.

**`stats/`** — `ModeStatsRow.tsx` routes to the per-mode Row 4 stat set; `ModeStatCards.tsx`, `StatCard.tsx`.

**`hooks/`** — `useMode.ts` (run-config → mode discriminator).

**`utils/`** — `metricsTransforms.ts` (SSE history → chart series), `reportToDerived.ts` (stored `RunReport` → the same `DashboardDerived` shape, so history reuses the live components), `computeBreakpoint.ts`, `computeEta.ts`, `chartGeometry.ts`. `types.ts` holds the shared dashboard types (`DashboardDerived`, etc.).

## History (`modules/history/`)

Past runs (single executions and load tests), split into a sidebar list and a main detail view.

**Sidebar (`sidebar/`):** `HistoryList.tsx` (filter/sort all runs; state from `useHistoryStore`, data from `useRunsQuery`) and `RunItem.tsx` (one run row — method badge, status, relative time, URL, load-test chips).

**Detail (`main/`):** `HistoryDetail.tsx` routes by run type to `DesignRunDetail.tsx` (single request execution — reuses the shared response viewer) or `LoadTestDetail.tsx` (load-test report). `LoadTestDetail` is **mode-aware** (header strip + tabs adapt to the run's mode, derived via `reportToDerived` → the same `DashboardDerived` shape the live dashboard uses) and composes the tabbed report under `main/components/`:

| Component | Role |
|---|---|
| `OverviewTab.tsx` | Summary — renders the dashboard's mode-adaptive `HeroRow` + `ModeStatsRow`; the Rate-Control card is gated to `constant_rps` |
| `PerformanceTab.tsx` | Latency/throughput detail |
| `SamplesTab.tsx`, `SampleRequestCard.tsx` | Sampled request/response pairs |
| `TimingBreakdown.tsx` | DNS/connect/TLS/first-byte/download breakdown |
| `LatencyMetric.tsx`, `MetricCard.tsx`, `HistoricalChartsSection.tsx` | Metric cards + historical charts |

> History detail reuses the live dashboard's `hero/`, `charts/`, and `stats/` components by feeding them a `DashboardDerived` built from the stored report (`reportToDerived`), so live and historical views stay visually consistent.

## Variables (`modules/variables/`)

- **Sidebar (`sidebar/VariablesCategoryTree.tsx`)** — tree of variable scopes (globals, collections, environments); receives `collections` + `environments` from the Sidebar.
- **Main (`main/`)** — `VariablesMain.tsx` (screen `"variables"`) hosts `VariableTableEditor.tsx`, the table editor for the selected scope, including the active-environment selector.

## Settings (`modules/settings/`)

- **Sidebar (`sidebar/SettingsCategoryTree.tsx`)** — settings category navigation.
- **Main (`main/`)** — `SettingsMain.tsx` (screen `"settings"`) hosting category panels such as `UISettingsPanel.tsx`.

## Welcome (`modules/welcome/`)

`WelcomeScreen.tsx` — default screen when no request/collection is selected; entry points include opening the import modal.

## Shared Response Viewer (`components/shared/response-viewer/`)

Response-rendering primitives reused outside the request builder (e.g. history detail):

- `UnifiedResponseViewer.tsx` — top-level response view
- `ResponseBody.tsx` — body rendering (JSON/text/HTML/XML)
- `HeadersViewer.tsx` — response headers

> Note: the request builder has its own richer `components/ResponseViewer/` (with console output, test results, cookies, raw request/response, client-error view). The `shared/response-viewer/` set is the lighter, reusable one.

## UI Primitives (`components/ui/`)

Primitives built on Radix UI + cmdk:

`badge`, `button`, `card`, `collapsible`, `command`, `delete-confirm-dialog`, `dialog`, `dropdown-menu`, `input`, `kbd`, `label`, `popover`, `resizable`, `scroll-area`, `select`, `separator`, `skeleton`, `switch`, `tabs`, `textarea`, `tooltip`, plus variable-aware inputs: `variable-autocomplete`, `variable-popover`, `variable-scope-badge`.

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

- **Local `useState`** — component-only UI state (dialog open/close, window maximized, window width).
- **Zustand stores (`stores/`)** — tabs (`useTabsStore`: open/active/add/close/focus), layout (`useLayoutStore`: drawer open/view/width, context bar open, split mode), dashboard metrics (`useDashboardStore`), variables (`useVariablesStore`), save (`useSaveStore`), engine connection, session (active environment), history filters, import-modal open-state.
- **TanStack Query (`queries/`)** — server state: collections, requests, runs, environments, globals, health, script completions; mutations for create/update/delete.

## Component Communication

- **Props / callbacks** — parent↔child.
- **Context** — module-local shared state (request builder).
- **Stores** — cross-module UI state + navigation.
- **Queries/mutations** — engine-backed server state.
