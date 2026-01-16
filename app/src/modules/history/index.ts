/**
 * History Module
 *
 * Components for displaying run history and details.
 *
 * Structure:
 * - sidebar/     - Components displayed in the sidebar (HistoryList)
 * - main/        - Components displayed in main content area (HistoryDetail, LoadTestDetail, DesignRunDetail)
 * - types.ts     - Shared types for history module
 *
 * Usage:
 * - Sidebar: Import from "@/modules/history/sidebar" or use "@/modules/history" and access via sidebar namespace
 * - Main: Import from "@/modules/history/main" or use "@/modules/history" and access via main namespace
 */

// Sidebar components (displayed in left sidebar)
export * as sidebar from "./sidebar";

// Main content components (displayed in main content area)
export * as main from "./main";

// Re-export commonly used components for convenience
export { default as HistoryList } from "./sidebar/HistoryList";
export { default as HistoryDetail } from "./main/HistoryDetail";
export { default as LoadTestDetail } from "./main/LoadTestDetail";
export { default as DesignRunDetail } from "./main/DesignRunDetail";

// Shared types
export * from "./types";
