/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Shared Response Viewer Components
 *
 * Centralized response display components used across the application.
 */

// Main exports
export { default as UnifiedResponseViewer } from "./UnifiedResponseViewer";
export { default as ResponseBody } from "./ResponseBody";
export { default as HeadersViewer, CompactHeadersViewer } from "./HeadersViewer";

// Pieces shared by the two response viewers. They are two different shells -
// seven tabs from live context, three from a stored run - so these are the
// parts that were genuinely identical, not an attempt to merge the shells.
export { ResponseStatusBar } from "./ResponseStatusBar";
export { ResponseActions } from "./ResponseActions";
export { ResponseHeadersPanel } from "./ResponseHeadersPanel";
export { RESPONSE_TAB_TRIGGER } from "./tab-trigger";
export type { ResponseStatusBarProps } from "./ResponseStatusBar";
export type { ResponseActionsProps } from "./ResponseActions";
export type { ResponseHeadersPanelProps } from "./ResponseHeadersPanel";

// Utilities
export {
	detectBodyType,
	formatBody,
	formatSize,
	getMonacoLanguage,
	buildRawResponse,
} from "./utils";

// Types
export type {
	BodyType,
	ViewMode,
	ResponseData,
	RequestData,
	TraceData,
	ResponseBodyProps,
	HeadersViewerProps,
	UnifiedResponseViewerProps,
} from "./types";
