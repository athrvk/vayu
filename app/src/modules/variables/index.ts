/**
 * Variables Module
 *
 * Components for managing variables (globals, collection-scoped, and environment variables).
 *
 * Structure:
 * - sidebar/     - Components displayed in the sidebar (VariablesCategoryTree)
 * - main/        - Components displayed in main content area (VariablesEditor, editors, etc.)
 *
 * Usage:
 * - Sidebar: Import from "@/modules/variables/sidebar" or use "@/modules/variables" and access via sidebar namespace
 * - Main: Import from "@/modules/variables/main" or use "@/modules/variables" and access via main namespace
 */

// Sidebar components (displayed in left sidebar)
export * as sidebar from "./sidebar";

// Main content components (displayed in main content area)
export * as main from "./main";

// Re-export commonly used components for convenience
export { default as VariablesCategoryTree } from "./sidebar/VariablesCategoryTree";
export { default as VariablesEditor } from "./main/VariablesEditor";
export { default as VariablesPanel } from "./main/VariablesPanel";
export { default as GlobalsEditor } from "./main/GlobalsEditor";
export { default as CollectionVariablesEditor } from "./main/CollectionVariablesEditor";
export { default as EnvironmentEditor } from "./main/EnvironmentEditor";
export { default as VariableInput } from "./main/VariableInput";
