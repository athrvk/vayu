# Modules Directory

This directory contains feature-based modules organized by domain. Each module is self-contained with its own components, types, and logic.

## Module Organization

**A module's main surface is imported from its own file, not from a barrel, by
anything that loads it lazily.** `Shell` mounts every surface but
`RequestBuilder` through `React.lazy` (#1146), and a barrel is one module: while
it imported `SettingsMain` from `@/modules/settings`, the Drawer's
`SettingsCategoryTree` - alive on every tab - came from that same file and put
the settings surface back in the startup chunk. The barrels below are still the
right import for anything already inside a surface; the deep path is what a lazy
boundary needs. The same reasoning is why `settings/main/app-panels.ts` holds no
components: whatever the always-mounted chrome reads, it loads.

### Modules with Both Sidebar and Main Components

Some modules have components displayed in both the sidebar and main content area. These are organized into subdirectories:

#### `history/`

- **Location:** Both sidebar and main
- **Sidebar:** `sidebar/HistoryList.tsx` - List of test runs
- **Main:** `main/HistoryDetail.tsx`, `main/LoadTestDetail.tsx`, `main/DesignRunView.tsx` - Run detail views
- **A design run opens as an editable copy, not a viewer.** `DesignRunView`
  renders the request builder itself, seeded from the stored run by
  `main/design-run-seed.ts`. The copy is detached: `id: null` and no `onSave`,
  so nothing typed in it can reach the saved request. Writing values back is a
  separate button that asks first.
- **Usage:**

    ```tsx
    // Sidebar
    import { HistoryList } from "@/modules/history/sidebar";

    // Main
    import { HistoryDetail } from "@/modules/history/main";
    ```

#### `variables/`

- **Location:** Both sidebar and main
- **Sidebar:** `sidebar/VariablesCategoryTree.tsx` - Tree navigation for variable scopes
- **Main:** `main/VariablesMain.tsx` - Variable editing interface, exported as
  `VariablesEditor`; the grid itself is `main/VariableTableEditor.tsx`
- **Usage:**

    ```tsx
    // Sidebar
    import { VariablesCategoryTree } from "@/modules/variables/sidebar";

    // Main
    import { VariablesEditor } from "@/modules/variables/main";
    ```

### Sidebar-Only Modules

#### `collections/`

- **Location:** Sidebar only
- **Components:** `CollectionTree.tsx` - Hierarchical tree of collections and requests
- **Usage:**
    ```tsx
    import CollectionTree from "@/modules/collections/CollectionTree";
    ```

#### `services/`

- **Location:** Sidebar only - the `services` drawer view (issue #502)
- **Components:** `ServicesPanel.tsx` - the local services (webhook inboxes, OAuth issuers):
  status, copy-URL, start/stop, and the issuer's start dialog
- **Also exports** `useRunningServiceCount()`, which the Dock's ambient indicator reads - one
  count over all three lists, because they disagree on their own terms (a stopped inbox stays
  listed, a stopped issuer or mock server does not)
- **Usage:**
    ```tsx
    import { ServicesPanel, useRunningServiceCount } from "@/modules/services";
    ```

#### `trash/`

- **Location:** Sidebar only - the `trash` drawer view (issue #989, over the engine's soft delete in #988)
- **Components:** `sidebar/TrashList.tsx` - deleted collections and requests, newest first, each
  with restore and purge-for-good actions; `sidebar/TrashItem.tsx` - one row
- **Also exports** `retentionCopy()` and `retentionDaysFrom()` (`retention.ts`), which turn the
  engine's `trashRetentionDays` config entry into the sentence the view puts under its title
- **Usage:**
    ```tsx
    import {
    	TrashList,
    	retentionCopy,
    	retentionDaysFrom,
    } from "@/modules/trash";
    ```

### Main-Only Modules

#### `request-builder/`

- **Location:** Main content area only
- **Component:** Main request builder interface for creating/editing HTTP requests
- **Usage:**
    ```tsx
    import RequestBuilder from "@/modules/request-builder";
    ```

#### `dashboard/`

- **Location:** Main content area only
- **Component:** Real-time load test metrics dashboard
- **Usage:**
    ```tsx
    import LoadTestDashboard from "@/modules/dashboard";
    ```

#### `welcome/`

- **Location:** Main content area only
- **Component:** Welcome screen shown when no request is selected
- **Usage:**
    ```tsx
    import WelcomeScreen from "@/modules/welcome/WelcomeScreen";
    ```

### Overlay Modules

#### `palette/`

- **Location:** neither sidebar nor main - a dialog mounted once by `Shell`, like `ImportModal`.
- **Components:** `CommandPalette.tsx` (dialog, ⌘K chord, focus restoration), `PaletteResults.tsx`
  (grouping and rendering, mounted only while open), `sources/` (one hook per result family).
- **Extending it:** add a `sources/use*Items.ts` returning `PaletteItem[]` and list it in
  `PaletteResults`. Nothing else changes - the dialog knows nothing about where a result came
  from. Perform the action through the same call the sidebar makes rather than a new one.
- **Usage:**
    ```tsx
    import { CommandPalette } from "@/modules/palette";
    ```

## Import Guidelines

1. **For modules with sidebar/main split:** Use explicit paths (`/sidebar` or `/main`) for clarity
2. **For single-location modules:** Import directly from module root
3. **For convenience:** Modules with splits also export commonly used components from root index

## Structure Pattern

```
modules/
├── [module-name]/
│   ├── sidebar/          # Sidebar components (if applicable)
│   ├── main/             # Main content components (if applicable)
│   ├── components/       # Shared sub-components
│   ├── types.ts          # Type definitions
│   ├── index.ts          # Main exports with documentation
│   └── README.md         # Module documentation (for complex modules)
```
