/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Utility functions for response body type detection and formatting
 */

import type { BodyType } from "./types";

/**
 * Detect content type from headers and body content
 */
export function detectBodyType(headers: Record<string, string>, body: string): BodyType {
	const contentType = headers["content-type"] || headers["Content-Type"] || "";
	const lowerContentType = contentType.toLowerCase();

	// Image types
	if (lowerContentType.includes("image/")) {
		return "image";
	}

	// PDF
	if (lowerContentType.includes("application/pdf")) {
		return "pdf";
	}

	// JSON
	if (lowerContentType.includes("application/json") || lowerContentType.includes("+json")) {
		return "json";
	}

	// JavaScript
	if (lowerContentType.includes("javascript") || lowerContentType.includes("application/js")) {
		return "javascript";
	}

	// CSS
	if (lowerContentType.includes("text/css")) {
		return "css";
	}

	// HTML
	if (lowerContentType.includes("text/html") || lowerContentType.includes("application/xhtml")) {
		return "html";
	}

	// XML
	if (
		lowerContentType.includes("xml") ||
		lowerContentType.includes("application/xml") ||
		lowerContentType.includes("+xml")
	) {
		return "xml";
	}

	// Markdown
	if (lowerContentType.includes("text/markdown")) {
		return "markdown";
	}

	// Binary types
	if (
		lowerContentType.includes("application/octet-stream") ||
		lowerContentType.includes("application/zip") ||
		lowerContentType.includes("application/gzip")
	) {
		return "binary";
	}

	// Try to detect from body content if content-type is generic or missing
	if (!contentType || lowerContentType.includes("text/plain")) {
		// Try JSON detection
		const trimmed = body.trim();
		if (
			(trimmed.startsWith("{") && trimmed.endsWith("}")) ||
			(trimmed.startsWith("[") && trimmed.endsWith("]"))
		) {
			try {
				JSON.parse(trimmed);
				return "json";
			} catch {
				// Not valid JSON
			}
		}

		// Try XML detection
		if (trimmed.startsWith("<?xml") || (trimmed.startsWith("<") && trimmed.includes("</"))) {
			return "xml";
		}

		// Try HTML detection
		if (
			trimmed.toLowerCase().includes("<!doctype html") ||
			trimmed.toLowerCase().includes("<html")
		) {
			return "html";
		}
	}

	return "text";
}

/**
 * Map body type to Monaco editor language
 */
export function getMonacoLanguage(bodyType: BodyType): string {
	const languageMap: Record<BodyType, string> = {
		json: "json",
		html: "html",
		xml: "xml",
		javascript: "javascript",
		css: "css",
		markdown: "markdown",
		text: "plaintext",
		binary: "plaintext",
		image: "plaintext",
		pdf: "plaintext",
	};
	return languageMap[bodyType] || "plaintext";
}

/**
 * Format body for display (pretty print JSON, etc.)
 */
export function formatBody(body: any, bodyType?: BodyType): string {
	if (!body) return "";

	// Handle object types (already parsed)
	if (typeof body === "object") {
		try {
			return JSON.stringify(body, null, 2);
		} catch {
			return String(body);
		}
	}

	// Try to format JSON
	if (bodyType === "json" || bodyType === undefined) {
		try {
			const parsed = JSON.parse(body);
			return JSON.stringify(parsed, null, 2);
		} catch {
			// Keep original if not valid JSON
		}
	}

	return String(body);
}

/**
 * Response time, at a precision anyone can read.
 *
 * Both response viewers printed `time.toFixed(4)` - `340.1235 ms`. Four decimal
 * places of a millisecond sit far below the resolution of what is measured, so
 * the last three digits are noise that changes every run, and they make the one
 * number people actually scan longer and harder to compare between runs.
 *
 * Sub-millisecond responses are the one range where decimals carry information
 * (a local mock, a cache hit), so they keep two.
 *
 * Lives here because it was fixed once in `ResponseHeader` and the identical
 * bug survived in `UnifiedResponseViewer` - the duplication was the defect.
 */
export function formatResponseTime(ms: number): string {
	const { value, unit } = formatDuration(ms);
	return `${value} ${unit}`;
}

/**
 * A duration split into its number and its unit, so a caller can style the unit
 * separately (these are rendered smaller and in `subtle-foreground` throughout).
 *
 * Use for independent values - a total, a queue wait - where each may sensibly
 * carry its own unit. For a set of values that are read against each other, use
 * `formatPhaseDuration`, which keeps more precision in the millisecond range.
 */
export function formatDuration(ms: number): { value: string; unit: DurationUnit } {
	if (ms < 1) return { value: ms.toFixed(2), unit: "ms" };
	if (ms < 1000) return { value: String(Math.round(ms)), unit: "ms" };
	/*
	 * Seconds all the way up, no minutes tier. This is a latency tool: a 65s
	 * response is already pathological and "65.43 s" says so more usefully than
	 * "1.1 min". Keeping it also makes this a pure refactor of the behaviour
	 * `formatResponseTime` already had.
	 */
	return { value: (ms / 1000).toFixed(2), unit: "s" };
}

/**
 * A single timing phase - DNS, connect, TLS, first byte, download - always in ms.
 *
 * Significant digits, because these five share a scale reading and their
 * magnitudes do not: a cached DNS lookup is 0.04ms while first-byte is
 * routinely 300ms. One fixed precision is wrong for one end or the other, and
 * the app had three different answers for the same five numbers - the dashboard
 * showed 2dp, the history breakdown 1dp, and the request-builder timing tab
 * already did this. This is that implementation, moved somewhere all three can
 * reach it.
 *
 * Distinct from `formatResponseTime`, which describes a whole response and
 * switches to seconds. A phase is always sub-second in practice and comparing
 * phases across a row matters more than the unit.
 */
export function formatPhaseMs(ms: number): string {
	if (ms >= 100) return ms.toFixed(0);
	if (ms >= 10) return ms.toFixed(1);
	return ms.toFixed(2);
}

export type DurationUnit = "ms" | "s";

/**
 * A timing phase, split into number and unit.
 *
 * Same unit rule as `formatDuration` - milliseconds until a full second, then
 * seconds - but it keeps the significant-digit ladder above, because a phase
 * needs precision `formatDuration` does not: a cached DNS lookup is 0.04ms and
 * rounding it to `0` erases the only signal there is.
 *
 * An earlier version fixed one unit across the whole row, on the theory that
 * phases are compared against each other. That was wrong in practice: it turned
 * a 262ms connect into `0.26 s` and a 0.96ms download into `0.00 s`. A
 * millisecond value is perfectly readable on its own, and the percentage column
 * beside it already carries the comparison. Only the phase that genuinely runs
 * into seconds should change unit.
 */
export function formatPhaseDuration(ms: number): { value: string; unit: DurationUnit } {
	if (ms < 1000) return { value: formatPhaseMs(ms), unit: "ms" };
	return { value: (ms / 1000).toFixed(2), unit: "s" };
}

/**
 * Format bytes to human readable size
 */
export function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Rebuild the raw HTTP request from the parts a stored trace keeps.
 *
 * A live execute gets `rawRequest` from the engine, which assembles the real
 * wire message (`build_raw_request`, engine/src/http/client.cpp). A restored
 * one has no such string - the design-mode trace stores method, url, headers
 * and body separately - and the restore path used to collapse all four into
 * `` `${method} ${url}` ``, so the Raw tab of a reopened run showed a single
 * line and the sent body was not reachable anywhere in the app.
 *
 * This mirrors the engine's assembly, in this order, so the two read the same:
 * request line with the *path* (not the absolute URL), `Host` from the
 * authority, the sent headers, `Content-Length` for a body, blank line, body.
 */
export function buildRawRequest(
	method: string,
	url: string,
	headers: Record<string, string> = {},
	body?: string
): string {
	let target = url;
	let host = "";
	try {
		const parsed = new URL(url);
		target = `${parsed.pathname}${parsed.search}` || "/";
		host = parsed.host;
	} catch {
		// A URL the platform will not parse - a scheme-less host, or one still
		// holding an unresolved {{variable}}. Keep the string whole rather than
		// inventing a split, and let the Host header fall away with it.
	}

	let raw = `${method || "GET"} ${target} HTTP/1.1\r\n`;
	if (host) raw += `Host: ${host}\r\n`;

	for (const [key, value] of Object.entries(headers)) {
		// Host is emitted from the URL above; a duplicate would be a protocol error.
		if (key.toLowerCase() === "host") continue;
		raw += `${key}: ${value}\r\n`;
	}

	// Bytes, not characters - the engine counts `content.size()`, and a body
	// with any non-ASCII in it makes the two differ.
	if (body) raw += `Content-Length: ${new TextEncoder().encode(body).length}\r\n`;

	raw += "\r\n";
	if (body) raw += body;

	return raw;
}

/**
 * Build raw HTTP response string
 */
export function buildRawResponse(
	status: number,
	statusText: string,
	headers: Record<string, string>,
	body: string
): string {
	let raw = `HTTP/1.1 ${status} ${statusText}\r\n`;

	// Add response headers
	for (const [key, value] of Object.entries(headers)) {
		raw += `${key}: ${value}\r\n`;
	}

	// Empty line between headers and body
	raw += "\r\n";

	// Add body
	if (body) {
		raw += body;
	}

	return raw;
}
