
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
