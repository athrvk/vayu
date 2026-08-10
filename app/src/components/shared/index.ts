/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Shared Components
 *
 * Reusable components used across multiple features in the application.
 */

// Response Viewer
export * from "./response-viewer";

// OAuth 2.0 auth form
export * from "./OAuth2Form";

// The one editor for concrete auth (both the request and collection auth tabs)
export * from "./AuthFields";

// One notice treatment: warnings, blockers and confirmations
export * from "./Callout";
export * from "./callout-severity";

// "These 100 samples are 100 of 30,000" - wherever a sampled set is displayed
export * from "./SampleRetentionNote";

// "p99 was 47ms against a 50ms budget" - wherever a run's verdict is shown
export * from "./ThresholdVerdict";
export * from "./CapacitySummary";

// "These responses were stored verbatim" - wherever captured samples are shown
export * from "./CapturedDataWarning";

// Row "⋯" actions menu (requests, environments)
export * from "./RowActionsMenu";

// HTTP method display (single source of truth)
export * from "./MethodBadge";

// Truncated text that scrolls on hover (tab strip)
export * from "./ScrollOnOverflow";

// Truncated text that reveals the full value on hover, only when clipped
export * from "./TruncatedText";

// Shared frame for the drawer views
export * from "./DrawerPanel";

// The one way to cancel a run in flight (load dashboard, collection runner)
export * from "./StopRunButton";

// The one way to say "there is nothing here yet"
export * from "./EmptyState";

// ...and the one way to say the load failed, which is not the same thing
export * from "./ErrorState";

// Loading placeholder for the drawer's list views
export * from "./ListSkeleton";

// Loading placeholder for a detail pane
export * from "./DetailSkeleton";
