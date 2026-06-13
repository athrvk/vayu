# Task 10c — Rewrite `docs/app/COMPONENTS.md` for new shell

## Context

Repository: `athrvk/vayu`. Work on branch `claude/clever-sagan-b4oTu`.

**Do this task after the full shell redesign (tasks 5a, 5b, 6a, 7b, 8a) is complete.**

`docs/app/COMPONENTS.md` is currently accurate for the old shell
(ActivityBar + Sidebar + Shell with resolveActiveScreen). After the redesign,
the shell component hierarchy changes substantially:

**Old hierarchy:**
```
Shell
├── TitleBar
├── Sidebar
│   ├── ActivityBar
│   └── SidebarPanel
│       ├── CollectionTree
│       ├── HistoryList
│       └── VariablesCategoryTree
└── main content (resolveActiveScreen switch)
```

**New hierarchy:**
```
Shell
├── TitleBar
│   ├── [logo]
│   ├── TabStrip
│   └── [env pill + window controls]
├── Drawer (resizable)
│   ├── CollectionTree  (view=collections)
│   ├── HistoryList     (view=history)
│   └── VariablesCategoryTree (view=variables)
├── main content (active tab type switch)
│   ├── WelcomeScreen   (type=welcome or zero-tab)
│   ├── RequestBuilderLayout (type=request)
│   ├── CollectionDetail (type=collection)
│   ├── LoadTestDashboard (type=dashboard)
│   ├── HistoryDetail   (type=run)
│   ├── VariablesMain   (type=variables)
│   └── SettingsMain    (type=settings)
├── ContextBar          (only for request tabs)
└── Dock
    ├── [drawer switchers]
    ├── [engine status + save status + version]
    └── [context bar toggle + settings]
```

## What to do

Read `docs/app/COMPONENTS.md` in full (it is large — read all sections).
Then read the actual component files to verify the new hierarchy:
- `app/src/components/layout/Shell.tsx`
- `app/src/components/layout/TitleBar.tsx`
- `app/src/components/layout/Drawer.tsx`
- `app/src/components/layout/TabStrip.tsx`
- `app/src/components/layout/Dock.tsx`
- `app/src/components/layout/ContextBar.tsx`

Rewrite the document sections that describe the shell hierarchy, the sidebar,
and "State Management in Components". Keep sections about module components
(RequestBuilder internals, CollectionTree, etc.) accurate — they don't change.

Specifically update:
1. The top-level hierarchy diagram.
2. The `Shell.tsx` section — describe tab-driven rendering.
3. The `Sidebar.tsx` section — replace with `Drawer.tsx` description.
4. Remove `ActivityBar` section — replaced by `Dock`.
5. Add sections for `TabStrip`, `Drawer`, `Dock`, `ContextBar`.
6. Update "State Management in Components" to reference `tabs-store` and
   `layout-store` instead of `navigation-store`.

## Acceptance criteria

- The document accurately reflects the new component hierarchy.
- No references to `ActivityBar`, `SidebarPanel`, or `resolveActiveScreen`.
- New components (`TabStrip`, `Drawer`, `Dock`, `ContextBar`) are documented.
- Markdown renders correctly.

## Files to touch

- `docs/app/COMPONENTS.md` (major rewrite of shell sections)
