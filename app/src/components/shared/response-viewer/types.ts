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

import type { RunResultStreamEvents } from "@/types/domain";

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

// Props for the unified response viewer
export interface UnifiedResponseViewerProps {
	response?: ResponseData | null;
	request?: RequestData | null;
	/**
	 * The stream this exchange received, when it was one (issue #657). Present
	 * turns on the Events tab; absent leaves the viewer with the two tabs it has
	 * always had, because a non-streaming sample has no timeline and an empty
	 * "Events" tab would suggest it did.
	 *
	 * Shaped as the engine serves it on `GET /runs/:id/samples` - a load sample
	 * carries no `endReason`, so this asks for none.
	 */
	events?: Omit<RunResultStreamEvents, "endReason"> | null;
	className?: string;
}
