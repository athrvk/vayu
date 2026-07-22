/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Shared Response Viewer Types
 *
 * Common types for response display components used across the application.
 */

// Extended body type to support more response formats
export type BodyType =
	| "json"
	| "html"
	| "xml"
	| "text"
	| "binary"
	| "image"
	| "pdf"
	| "javascript"
	| "css"
	| "markdown";

// View mode for response body
export type ViewMode = "pretty" | "raw" | "preview";

// Response data structure for display
export interface ResponseData {
	body: string;
	bodyRaw?: string; // Raw response body from server (used for raw view mode)
	headers: Record<string, string>;
	status?: number;
	statusText?: string;
	time?: number;
	size?: number;
}

// Request data structure for display
export interface RequestData {
	method?: string;
	url?: string;
	headers?: Record<string, string>;
	body?: string;
}

// Props for response body component
export interface ResponseBodyProps {
	body: string;
	bodyRaw?: string; // Raw response body from server (used for raw view mode)
	headers: Record<string, string>;
	className?: string;
}

// Props for headers viewer component
export interface HeadersViewerProps {
	headers: Record<string, string>;
	title?: string;
	defaultOpen?: boolean;
	variant?: "response" | "request";
	className?: string;
}

/**
 * Props for the embedded response viewer.
 *
 * `compact`, `showActions`, `hiddenTabs` and `trace` are gone with the full
 * mode: two of them only ever steered the branch that no longer exists, and the
 * remaining caller's `hiddenTabs={["request"]}` named a tab the embedded view
 * never had - it was passed, matched nothing, and hid nothing.
 */
export interface UnifiedResponseViewerProps {
	response?: ResponseData | null;
	request?: RequestData | null;
	className?: string;
}
