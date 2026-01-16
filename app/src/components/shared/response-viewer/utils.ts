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
 * Format bytes to human readable size
 */
export function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
