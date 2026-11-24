---
description: >-
  State in the Vayu app: Zustand stores for UI state, TanStack Query for server state, the query keys, and the cache policy.
---

# State Management

The Vayu app uses a dual-state management approach: **Zustand** for UI state and **TanStack Query** for server state.
**Cross-cutting stores** (tabs, layout, session, engine, save, response, dashboard, client settings, toasts, import modal, environment menu) live in `app/src/stores/` and are exported via the barrel `app/src/stores/index.ts`.
**Module-local UI stores** co-locate in `app/src/modules/<feature>/<feature>-store.ts` (collections, history, variables, settings) to keep feature-specific UI state decoupled from global app state.

## Pages

Each page holds the stores or hooks of one part of the app's state.

| Page | Covers |
|---|---|
| [Tabs, layout and session stores](tabs-layout-session.md) | `tabs-store.ts`, `layout-store.ts`, `session-store.ts` |
| [Data file, spec file, bound row and recovery notice stores](data-and-spec-files.md) | `data-file-store.ts`, `spec-file-store.ts`, `bound-row-store.ts`, `recovery-notice-store.ts` |
| [Engine, response and console stores](engine-and-response.md) | `engine-store.ts`, `response-store.ts`, `console-store.ts` |
| [Save and entity draft stores](save-and-drafts.md) | `save-store.ts`, `entity-draft-store.ts` |
| [Tab selection, appearance, theme and client settings stores](preferences.md) | `tab-selection-store.ts`, `appearance-store.ts`, `theme-store.ts`, `client-settings-store.ts` |
| [Dashboard and live run stores](run-live-state.md) | `dashboard-store.ts`, `host-sleep-store.ts`, `scenario-run-store.ts`, `execution-events-store.ts` |
| [Notice, menu and modal stores](notices-and-menus.md) | `update-verification-store.ts`, `inbox-notify-store.ts`, `import-modal-store.ts`, `env-switcher-store.ts`, `import-report-store.ts`, `oauth-signin-store.ts`, `toast-store.ts` |
| [Module-Local Stores](module-local-stores.md) | `modules/*/*-store.ts`, `lib/graphql/*-store.ts` |
| [TanStack Query (Server State)](query-hooks.md) | Query hooks |
| [Query Keys & Cache Invalidation](query-keys.md) | Query keys, cache invalidation, cache policy |
| [Custom Hooks](engine-and-variable-hooks.md) | `useEngine()`, live metrics streaming, `useVariableResolver()` |
| [RequestBuilderContext](request-builder-context.md) | `RequestBuilderContext` |
| [Save and draft hooks](draft-hooks.md) | `useSaveManager()`, `useEntityDraft()`, `useDraftSaveContext()`, draft adoption |
| [State flow examples and best practices](flows-and-practices.md) | State flow examples, best practices |

## Architecture Overview

```
┌─────────────────────────────────────────────────┐
│           State Management Layers                │
├─────────────────────────────────────────────────┤
│  UI State (Zustand)                             │
│  - Cross-cutting: tabs, layout, session         │
│  - Domain: engine, save, response, dashboard    │
│  - Module-local: collections, history, vars     │
└─────────────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────┐
│  Server State (TanStack Query)                  │
│  - Collections, Requests, Environments           │
│  - Runs, Metrics, Global Variables              │
│  - Automatic caching & synchronization          │
└─────────────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────┐
│  Services Layer                                 │
│  - HTTP Client (api.ts)                        │
│  - SSE Client (sse-client.ts)                  │
└─────────────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────┐
│  Vayu Engine (C++ Daemon)                      │
│  - SQLite Database                              │
│  - HTTP API (localhost:9876)                    │
└─────────────────────────────────────────────────┘
```

## Zustand Stores

### Cross-Cutting Stores (`app/src/stores/`)
