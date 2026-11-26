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

## Pages

Each page below holds one module, or a few small ones, of the sections that follow.

| Page | Covers |
|---|---|
| [App Shell](app-shell.md) | The app shell: `App`, error handling, the title bar, tab strip, shell, drawer, context bar and rail, activity rail, bottom panel, dock and context menus |
| [Request Builder](request-builder.md) | `modules/request-builder/` |
| [GraphQL Library](graphql-library.md) | `lib/graphql/` |
| [Drag Primitives and Agent References](drag-and-agent-references.md) | Drag primitives, Agent references |
| [Collections](collections.md) | `modules/collections/` |
| [Load Test Dashboard](dashboard.md) | `modules/dashboard/` |
| [History](history.md) | `modules/history/` |
| [Variables and Settings](variables-and-settings.md) | Variables, Settings |
| [Webhook Inbox](inbox.md) | `modules/inbox/` |
| [Services](services.md) | `modules/services/` |
| [Mock Server](mock-server.md) | `modules/mock-server/` |
| [Logs and Console](logs-and-console.md) | Logs, Console |
| [Welcome](welcome.md) | `modules/welcome/` |
| [Command Palette](palette.md) | `modules/palette/` |
| [Command Registry](command-registry.md) | `lib/commands/` |
| [Shared: Breadcrumb, Toasts and Run Status](shared-run-status.md) | Tab Breadcrumb, Toaster, Run Status Pill, Run Outcome Banner, Stop Run Button, Sample Retention Note, Error Summary |
| [Shared: Run Results](shared-run-results.md) | Threshold Verdict, Capacity Summary, Contract Coverage, Sampled Schema Validation, Test Validation Summary, Scenario step cells |
| [Shared: Warnings and Banners](shared-warnings-and-banners.md) | Element Tally, Extractor Misses, Unresolved Tokens, Captured Data Warning, Stored Exchange Warning, Exchange Warnings, Recovery Banner, Update Banner, Non-Loopback Badge |
| [Shared: Fields and Snippets](shared-fields.md) | Drawer Section, Field Error, Allowed Origins Field, Number Field, Shared External Change Callout, Shared Script Snippets |
| [Shared: ElementList](shared-element-list.md) | `components/shared/ElementList/` |
| [Shared: Response Viewer and Auth](shared-response-viewer.md) | Shared Response Viewer, Shared Auth Fields, Shared OAuth 2.0 Form |
| [Shared: Key/Value Editor](shared-key-value-editor.md) | `components/shared/KeyValueEditor/` |
| [Shared: Variable Input](shared-variable-input.md) | `components/shared/VariableInput/` |
| [UI Primitives](ui-primitives.md) | `components/ui/` |
| [Patterns and State](patterns.md) | Component Patterns, State Management in Components, Component Communication |

## Component Hierarchy

```
<App />                                  // App.tsx - mounts providers, kicks off health/prefetch queries, OS theme sync
├── <TitleBar />                         // components/layout/TitleBar.tsx - --titlebar-height drag region: icon + centered search bar + env pill
│   ├── AppIcon (Windows and Linux - the application-menu button; the system-menu control on Windows)
│   ├── <CommandSearchBar />             // Input-shaped trigger for the ⌘K palette; never its own search
│   └── EnvPill + WindowControls (Linux only; Windows native overlay; macOS traffic lights)
├── <RecoveryBanner />                   // components/shared/RecoveryBanner.tsx - only when the engine restored or deleted the database
├── <UpdateBanner />                     // components/shared/UpdateBanner.tsx - a newer release: progress, "Verifying", restart-to-install, why the installer was refused (#2372), or that the download failed, with Retry (#3338)
├── <KeepAwakePrompt />                  // components/shared/KeepAwakePrompt.tsx - asks once about a run long enough for the machine to sleep under it (#1357)
└── <Shell />                            // components/layout/Shell.tsx - tab-centric layout with drawer + context bar
    ├── <ImportModal />                  // modules/collections/ImportModal.tsx - global overlay, open-state in a store
    ├── <CommandPalette />               // modules/palette/ - ⌘K overlay; open-state in layout-store
    ├── <RunAnnouncer />                 // components/layout/RunAnnouncer.tsx - sr-only live region: a run started, how it ended (#3498)
    ├── <ActivityRail />                 // components/layout/ActivityRail.tsx - w-[var(--rail-width)]; the six Drawer-view buttons; F6 region "rail"
    ├── <Drawer />                       // components/layout/Drawer.tsx - resizable 220–480px; single left nav; switches views; push ≥1000px / overlay <1000px
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
    ├── <ContextRail />                  // components/layout/ContextRail.tsx - w-[var(--rail-width)]; one icon per applicable context-bar section; F6 region "context-rail"
    ├── <BottomPanel />                  // components/layout/BottomPanel.tsx - full-width band under the main row, only while open; resizable from its top edge; tab strip over the active tab (Console: modules/console/, Logs: modules/logs/); F6 region "bottom-panel"
    └── <Dock />                         // components/layout/Dock.tsx - status in the centre (engine/save state, pending restart); the bottom panel's button then per-tab view controls (request tabs) on the right; F6 region "dock"
```
