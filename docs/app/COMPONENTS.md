# Component Architecture

The React component structure of the Vayu app (`app/src`).

The UI is organized into two top-level trees:

- **`components/`** — app-shell layout, status, shared response rendering, and the `ui/` primitive library. Cross-cutting pieces not owned by a single feature.
- **`modules/`** — feature modules, each self-contained (its own components, and where needed `context/`, `hooks/`, `utils/`, `shared/`): `request-builder`, `collections`, `dashboard`, `history`, `variables`, `settings`, `welcome`.

State lives outside components: **Zustand** stores (`stores/`) for UI/navigation state, **TanStack Query** (`queries/`) for server state from the engine.

## Component Hierarchy

```
<App />                                  // App.tsx — mounts providers, kicks off health/prefetch queries, OS theme sync
├── <TitleBar />                         // components/layout/TitleBar.tsx
└── <Shell />                            // components/layout/Shell.tsx — resizable sidebar + routed main area, Ctrl/Cmd+S
    ├── <ImportModal />                  // modules/collections/ImportModal.tsx — global overlay, open-state in a store
    ├── <Sidebar />                      // components/layout/Sidebar.tsx — VS Code-style activity bar + collapsible panel
    │   ├── <CollectionTree />           //   collections tab
    │   ├── <HistoryList />              //   history tab
    │   ├── <VariablesCategoryTree />    //   variables tab
    │   ├── <SettingsCategoryTree />     //   settings tab (bottom)
    │   └── <ConnectionStatus />         //   pinned to panel footer
    │
    └── main content (switched on navigationStore.resolveActiveScreen())
        ├── <WelcomeScreen />            // "welcome"          modules/welcome/
        ├── <RequestBuilder />           // "request-builder"  modules/request-builder/
        ├── <CollectionDetail />         // "collection-detail" modules/collections/CollectionDetail/
        ├── <LoadTestDashboard />        // "dashboard"        modules/dashboard/
        ├── <HistoryDetail />            // "history"          modules/history/main/
        ├── <VariablesMain />            // "variables"        modules/variables/main/
        └── <SettingsMain />             // "settings"         modules/settings/main/
```

## App Shell

### `App` (`App.tsx`)

Root component. Renders `<TitleBar />` over `<Shell />`. On mount it wires up app-wide concerns via hooks/queries: OS/Electron theme sync (`useElectronTheme`), engine health polling (`useHealthQuery`), and prefetching of server state (`usePrefetchCollectionsAndRequests`, `useRunsQuery`, `useScriptCompletionsQuery`).

### `Shell` (`components/layout/Shell.tsx`)

Main layout: a resizable sidebar beside a routed content area.

- **Routing:** reads `resolveActiveScreen()` from `useNavigationStore()` and renders one of the seven screens (see hierarchy). Default/fallback is `WelcomeScreen`.
- **Resizable sidebar** via `useResizable` — width 280–600px; the floor rises to 420px while the History tab is active (RunItems need room for URL + chips).
- **`Ctrl/Cmd+S`** global handler → `useSaveStore().triggerSave()`.
- Mounts **`<ImportModal />`** once, at the shell level, as a global overlay (visibility lives in an import-modal store).

### `TitleBar` (`components/layout/TitleBar.tsx`)

Custom window title bar (Electron frameless window chrome).

### `Sidebar` (`components/layout/Sidebar.tsx`)

VS Code–style **activity bar + collapsible panel**.

- **Activity bar:** top tabs `Collections`, `History`, `Variables`; bottom tab `Settings`. Clicking the active tab while open collapses the panel.
- **Panel** renders per tab: `CollectionTree` / `HistoryList` / `VariablesCategoryTree` / `SettingsCategoryTree`, with `ConnectionStatus` pinned to the footer.
- Tab state and navigation come from `useNavigationStore()` (`activeSidebarTab`, `navigateToVariables`, `navigateToSettings`, …).

### `ConnectionStatus` (`components/status/ConnectionStatus.tsx`)

Engine connection indicator, driven by the engine-connection store + health query.

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
| `components/UrlBar/` | `index`, `MethodSelector`, `UrlInput` — method dropdown, URL input (variable highlighting), Send + Load Test buttons |
| `components/RequestTabs/` | `index` + `panels/`: `ParamsPanel`, `HeadersPanel`, `BodyPanel`, `AuthPanel`, `AuthInheritBanner`, `PreScriptPanel`, `TestScriptPanel` |
| `components/ResponseViewer/` | `index`, `ResponseHeader`, `ResponseHeadersTab`, `ResponseCookies`, `TestResults`, `ConsoleOutput`, `RawRequestResponse`, `ClientErrorView` |
| `components/RequestDescription.tsx` | Editable request description |
| `components/LoadTestConfigDialog.tsx` | Load-test configuration dialog (mode, duration, RPS, concurrency, …) |
| `shared/KeyValueEditor/` | `index`, `KeyValueRow` — reusable key/value table (params, headers, form fields) |
| `shared/VariableInput/` | `index`, `EditableVariable` — input with `{{variable}}` highlighting + autocomplete |
| `hooks/`, `utils/` | Module hooks; `utils/key-value` (flat↔entry conversions), `utils/id` |

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

Connects to the engine SSE metrics stream (via the load-test service / dashboard store), shows live metrics while running, and loads the final report on completion. Stop action supported.

| Component | Role |
|---|---|
| `components/DashboardHeader.tsx` | Title, run status, stop button |
| `components/RunMetadata.tsx` | Endpoint, config (mode/duration/RPS/concurrency), timing |
| `components/MetricsView.tsx` | Live metrics + charts (RPS, latency percentiles, error rate, concurrency) |
| `components/RequestResponseView.tsx` | Status-code distribution, error breakdown, timing breakdown, sampled requests |
| `components/MetricCard.tsx` | Single metric stat card |

## History (`modules/history/`)

Past runs (single executions and load tests), split into a sidebar list and a main detail view.

**Sidebar (`sidebar/`):** `HistoryList.tsx` (filter/sort all runs; state from `useHistoryStore`, data from `useRunsQuery`) and `RunItem.tsx` (one run row — method badge, status, relative time, URL, load-test chips).

**Detail (`main/`):** `HistoryDetail.tsx` routes by run type to `DesignRunDetail.tsx` (single request execution — reuses the shared response viewer) or `LoadTestDetail.tsx` (load-test report). `LoadTestDetail` composes the tabbed report under `main/components/`:

| Component | Role |
|---|---|
| `OverviewTab.tsx` | Summary metrics |
| `PerformanceTab.tsx` | Latency/throughput detail |
| `SamplesTab.tsx`, `SampleRequestCard.tsx` | Sampled request/response pairs |
| `TimingBreakdown.tsx` | DNS/connect/TLS/first-byte/download breakdown |
| `LatencyMetric.tsx`, `MetricCard.tsx`, `HistoricalChartsSection.tsx` | Metric cards + historical charts |

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

- **Local `useState`** — component-only UI state (dialog open/close, active tab, sidebar width).
- **Zustand stores (`stores/`)** — navigation (`useNavigationStore`), dashboard metrics (`useDashboardStore`), variables (`useVariablesStore`), save (`useSaveStore`), engine connection, history filters, import-modal open-state.
- **TanStack Query (`queries/`)** — server state: collections, requests, runs, environments, globals, health, script completions; mutations for create/update/delete.

## Component Communication

- **Props / callbacks** — parent↔child.
- **Context** — module-local shared state (request builder).
- **Stores** — cross-module UI state + navigation.
- **Queries/mutations** — engine-backed server state.
