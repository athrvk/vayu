/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type { HeaderLine, RunResultStreamEvents } from "@/types/domain";
import type { HeaderLine as WireHeaderLine } from "./wire-headers";
import type { ResponseBytes } from "@/modules/request-builder/utils/response-bytes";

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
	/** `ResponseState.rawBytes`: the exact bytes of a body the engine sent as base64. */
	rawBytes?: ResponseBytes;
	headers: Record<string, string>;
	/** `ResponseState.headerLines`. Absent for a sample that kept the folded map only. */
	headerLines?: HeaderLine[];
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
	/** As `ResponseData.rawBytes`: the bytes of a body with no text view, drawn in place of `body`. */
	rawBytes?: ResponseBytes;
}

// Props for response body component
export interface ResponseBodyProps {
	body: string;
	bodyRaw?: string; // Raw response body from server (used for raw view mode)
	/**
	 * `ResponseState.rawBytes`; its `isText` is the funnel's verdict, taken rather than sniffed
	 * again.
	 */
	rawBytes?: ResponseBytes;
	headers: Record<string, string>;
	className?: string;
}

// Props for headers viewer component
export interface HeadersViewerProps {
	/** A map, or the lines in order when a name may repeat (`WireHeaderLine`). */
	headers: Record<string, string> | readonly WireHeaderLine[];
	/**
	 * The lines as received (#2460): repeats kept, names in the server's case. Read only beside a
	 * map `headers`; absent or empty, the table is built from the map, one row per name, all a
	 * load-run sample, an inbox capture and a request's own headers have.
	 */
	headerLines?: HeaderLine[];
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
	 * The stream this exchange received, when it was one (#657): present turns on the Events tab;
	 * absent leaves the viewer's two tabs, as a non-streaming sample has no timeline and an empty
	 * "Events" would suggest one. Shaped as `GET /runs/:id/samples` serves it: a load sample
	 * carries no `endReason`.
	 */
	events?: Omit<RunResultStreamEvents, "endReason" | "startedAt"> | null;
	className?: string;
}
