# Component Architecture

This document describes the React component structure of the Vayu Manager application.

## Component Hierarchy

```
<App />
└── <Shell />
    ├── <Sidebar />
    │   ├── <CollectionTree />
    │   ├── <HistoryList />
    │   ├── <VariablesCategoryTree />
    │   └── <ConnectionStatus />
    │
    └── <MainContent /> (based on activeScreen)
        ├── <WelcomeScreen />
        ├── <RequestBuilder />
        │   ├── <UrlBar />
        │   ├── <RequestTabs />
        │   │   ├── ParamsTab
        │   │   ├── HeadersTab
        │   │   ├── BodyTab
        │   │   ├── AuthTab
        │   │   └── ScriptsTab
        │   └── <ResponseViewer />
        ├── <LoadTestDashboard />
        │   ├── <DashboardHeader />
        │   ├── <RunMetadata />
        │   ├── <MetricsView />
        │   └── <RequestResponseView />
        ├── <HistoryDetail />
        └── <VariablesEditor />
```

## Core Layout Components

### `Shell` (`components/layout/Shell.tsx`)

Main application layout with resizable sidebar and content area.

**Features:**
- Resizable sidebar (200px - 600px width)
- Keyboard shortcut handler (`Ctrl/Cmd+S` for save)
- Routes to correct screen based on `activeScreen` from `useAppStore()`

**State:**
- Sidebar width (local state)
- Resizing state (local state)

### `Sidebar` (`components/layout/Sidebar.tsx`)

Tab-based navigation with four tabs: Collections, History, Variables, Settings.

**Features:**
- Tab switching with memory (remembers last screen per tab)
- Connection status indicator
- Active tab highlighting

**State:**
- Active tab from `useAppStore().activeSidebarTab`

## Request Builder Components

### `RequestBuilder` (`components/request-builder/index.tsx`)

Main container for the request editor. Provides context and orchestrates sub-components.

**Architecture:**
- Wrapped in `RequestBuilderProvider` for state management
- Uses `ResizablePanelGroup` for vertical layout
- Handles request execution and load test initiation

**Key Responsibilities:**
- Fetches request data via `useRequestQuery()`
- Converts between domain types and component state
- Resolves variables before sending requests
- Manages load test dialog

**Sub-components:**
- `UrlBar`: Method selector, URL input, Send button
- `RequestTabs`: Tabs for params, headers, body, auth, scripts
- `ResponseViewer`: Displays response, headers, test results

### `UrlBar` (`components/request-builder/components/UrlBar.tsx`)

URL bar with HTTP method selector and Send button.

**Features:**
- Method dropdown (GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS)
- URL input with variable highlighting
- Send button (executes request)
- Load Test button (opens load test config dialog)

### `RequestTabs` (`components/request-builder/components/RequestTabs.tsx`)

Tabbed interface for request configuration.

**Tabs:**
1. **Params**: Query parameters (key-value pairs)
2. **Headers**: HTTP headers (key-value pairs)
3. **Body**: Request body (JSON, text, form-data, x-www-form-urlencoded)
4. **Auth**: Authentication (Bearer, Basic, API Key)
5. **Scripts**: Pre-request and test scripts (Monaco Editor)

### `ResponseViewer` (`components/shared/response-viewer/`)

Displays HTTP response with multiple views.

**Features:**
- Response body viewer (JSON, text, HTML)
- Headers display
- Test results (pass/fail)
- Console logs from scripts
- Timing breakdown
- Status code and status text

## Load Test Dashboard Components

### `LoadTestDashboard` (`components/load-test-dashboard/index.tsx`)

Main container for load test metrics display.

**Architecture:**
- Connects to SSE stream via `useSSE()` hook
- Manages two views: Metrics and Request/Response
- Loads final report when test completes

**Key Responsibilities:**
- Initializes dashboard state when load test starts
- Streams real-time metrics from engine
- Fetches final report after completion
- Handles stop action

**Sub-components:**
- `DashboardHeader`: Title, status, stop button
- `RunMetadata`: API endpoint, config, timing info
- `MetricsView`: Live metrics, charts (RPS, latency, errors)
- `RequestResponseView`: Status codes, errors, timing breakdown

### `MetricsView` (`components/load-test-dashboard/components/MetricsView.tsx`)

Real-time metrics visualization with charts.

**Metrics Displayed:**
- Requests per second (RPS)
- Latency percentiles (P50, P95, P99)
- Error rate
- Total requests (completed/failed)
- Current concurrency

**Charts:**
- RPS over time (line chart)
- Latency over time (line chart)
- Error rate over time (line chart)

### `RequestResponseView` (`components/load-test-dashboard/components/RequestResponseView.tsx`)

Detailed view of request/response data.

**Features:**
- Status code distribution (bar chart)
- Error breakdown by type
- Timing breakdown (DNS, connect, TLS, first byte, download)
- Slow requests list
- Sampled request/response pairs

## History Components

### `HistoryList` (`components/history/HistoryList.tsx`)

List of all runs (design and load tests).

**Features:**
- Filtering by type, status, date range
- Sorting by date, status
- Click to view details

**State:**
- Filter state from `useHistoryStore()`
- Run data from `useRunsQuery()`

### `HistoryDetail` (`components/history/HistoryDetail.tsx`)

Detailed view of a single run.

**Features:**
- Run metadata (config, timing)
- For design runs: Response viewer
- For load tests: Final report display (same as dashboard)

**Sub-components:**
- `DesignRunDetail`: Single request execution details
- `LoadTestDetail`: Load test report (reuses dashboard components)

## Variables Components

### `VariablesEditor` (`components/variables/VariablesEditor.tsx`)

Main container for variable management.

**Features:**
- Tree view of variable scopes (globals, collections, environments)
- Editor for selected scope
- Active environment selector

**Sub-components:**
- `VariablesCategoryTree`: Tree navigation
- `GlobalsEditor`: Global variables editor
- `CollectionVariablesEditor`: Collection-scoped variables
- `EnvironmentEditor`: Environment variables with active toggle

### `VariableInput` (`components/variables/VariableInput.tsx`)

Input component with variable highlighting and autocomplete.

**Features:**
- Syntax highlighting for `{{variables}}`
- Autocomplete dropdown
- Inline variable editing
- Scope badges (global/collection/environment)

## Collections Components

### `CollectionTree` (`components/collections/CollectionTree.tsx`)

Hierarchical tree view of collections and requests.

**Features:**
- Expandable/collapsible folders
- Drag-and-drop reordering (future)
- Context menu (rename, delete, new request)
- Request icons by HTTP method

**State:**
- Expansion state from `useCollectionsStore()`
- Data from `useCollectionsQuery()` and `useRequestsQuery()`

### `CollectionItem` (`components/collections/CollectionItem.tsx`)

Individual collection folder item.

**Features:**
- Click to select
- Context menu
- Nested children display

### `RequestItem` (`components/collections/RequestItem.tsx`)

Individual request item in tree.

**Features:**
- Method badge (GET, POST, etc.)
- Click to open in RequestBuilder
- Context menu (rename, delete, duplicate)

## Shared UI Components (`components/ui/`)

Primitive components built on Radix UI:

- **Button**: Various variants and sizes
- **Input**: Text input with labels
- **Label**: Form labels
- **Dialog**: Modal dialogs
- **Popover**: Popover menus
- **DropdownMenu**: Dropdown menus
- **Tabs**: Tab interface
- **Select**: Dropdown select
- **ScrollArea**: Scrollable containers
- **Card**: Card containers
- **Badge**: Status badges
- **Separator**: Visual separators
- **Tooltip**: Tooltips
- **Collapsible**: Expandable sections
- **Command**: Command palette (cmdk)
- **Resizable**: Resizable panels
- **TemplatedInput**: Input with variable highlighting

## Component Patterns

### Context Pattern

Components like `RequestBuilder` use React Context for local state:

```typescript
<RequestBuilderProvider>
  <UrlBar />
  <RequestTabs />
  <ResponseViewer />
</RequestBuilderProvider>
```

### Compound Components

Some components use compound component pattern (e.g., `Tabs`, `Dialog`):

```typescript
<Tabs>
  <TabsList>
    <TabsTrigger>Tab 1</TabsTrigger>
  </TabsList>
  <TabsContent>Content</TabsContent>
</Tabs>
```

### Controlled Components

Most form components are controlled, with state managed by parent or store:

```typescript
<Input
  value={request.url}
  onChange={(e) => updateField('url', e.target.value)}
/>
```

## State Management in Components

- **Local State**: Use `useState` for component-specific UI state (e.g., dialog open/close)
- **Zustand Stores**: Use for shared UI state (navigation, dashboard metrics)
- **TanStack Query**: Use for server state (collections, requests, runs)

## Component Communication

- **Props**: Parent-to-child data flow
- **Callbacks**: Child-to-parent events
- **Context**: Shared state within component tree
- **Stores**: Global state access
- **Queries**: Server state access
