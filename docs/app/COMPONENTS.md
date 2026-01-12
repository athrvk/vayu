# Component Specifications

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
        │   └── <ResponseViewer />
        ├── <LoadTestDashboard />
        │   ├── <DashboardHeader />
        │   ├── <RunMetadata />
        │   ├── <MetricsView />
        │   └── <RequestResponseView />
        ├── <HistoryDetail />
        └── <VariablesEditor />
```

## Core Components

### Shell (`components/layout/Shell.tsx`)

Main app layout with resizable sidebar and content area.

- Handles `Ctrl/Cmd+S` for save
- Routes to correct screen based on `activeScreen` from store

### Sidebar (`components/layout/Sidebar.tsx`)

Tab-based navigation with four tabs: Collections, History, Variables, Settings.

### RequestBuilder (`components/request-builder/index.tsx`)

Full request editor with:
- URL bar (method + URL + Send button)
- Tabs: Params, Headers, Body, Auth, Scripts
- Response viewer with body, headers, test results

### LoadTestDashboard (`components/load-test-dashboard/index.tsx`)

Real-time metrics display during load tests:
- Connects to SSE stream via `useSSE()`
- Shows RPS, latency percentiles, error rates
- Switches between metrics view and request/response view

### CollectionTree (`components/collections/CollectionTree.tsx`)

Nested folder navigation for collections and requests.

### VariablesEditor (`components/variables/VariablesEditor.tsx`)

Edit variables for globals, collections, or environments.

## UI Components (`components/ui/`)

Shared primitives built on Radix UI:
- Button, Input, Label
- Dialog, Popover, DropdownMenu
- Tabs, Select, ScrollArea
- Card, Badge, Separator
- Tooltip, Collapsible
- Command (cmdk), Resizable
- TemplatedInput (variable highlighting)
