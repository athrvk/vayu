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

// Full HTTP trace data
export interface TraceData {
	request?: RequestData;
	response?: ResponseData;
	dnsMs?: number;
	connectMs?: number;
	tlsMs?: number;
	firstByteMs?: number;
	downloadMs?: number;
}

// Props for response body component
export interface ResponseBodyProps {
	body: string;
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

// Props for the unified response viewer
export interface UnifiedResponseViewerProps {
	response?: ResponseData | null;
	request?: RequestData | null;
	trace?: TraceData | null;
	/** Compact mode for embedded views (history cards) */
	compact?: boolean;
	/** Show copy/download actions */
	showActions?: boolean;
	/** Additional tabs to hide */
	hiddenTabs?: string[];
	className?: string;
}
