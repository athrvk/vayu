---
description: >-
  Patterns the Vayu desktop app's components follow: module-local context, compound components, controlled inputs, state and communication.
---

# Patterns and State

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
