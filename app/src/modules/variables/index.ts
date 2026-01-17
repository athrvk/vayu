
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

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
export { default as VariablesEditor } from "./main/VariablesMain";
export { default as VariableTableEditor } from "./main/VariableTableEditor";
