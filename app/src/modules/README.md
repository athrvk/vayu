# Modules Directory

This directory contains feature-based modules organized by domain. Each module is self-contained with its own components, types, and logic.

## Module Organization

### Modules with Both Sidebar and Main Components

Some modules have components displayed in both the sidebar and main content area. These are organized into subdirectories:

#### `history/`

- **Location:** Both sidebar and main
- **Sidebar:** `sidebar/HistoryList.tsx` - List of test runs
- **Main:** `main/HistoryDetail.tsx`, `main/LoadTestDetail.tsx`, `main/DesignRunDetail.tsx` - Run detail views
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
- **Main:** `main/VariablesEditor.tsx` and related editors - Variable editing interface
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
