/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Utility functions for response body type detection and formatting
 */

import { formatJson } from "@/lib/json-format";
import { formatXml } from "@/lib/xml-format";
import { resolveHeaderLines } from "@/lib/header-lines";
import type { HeaderLine } from "@/types/domain";
import {
	headerValueOf,
	mediaTypeOf,
	type MediaType,
} from "@/modules/request-builder/utils/response-bytes";
import type { BodyType } from "./types";

/**
 * Detect content type from headers and body content
 */
export function detectBodyType(headers: Record<string, string>, body: string): BodyType {
	const contentType = headers["content-type"] || headers["Content-Type"] || "";
	const media = mediaTypeOf(contentType);
	const declared = declaredBodyType(media);
	if (declared) return declared;

	// Try to detect from body content if content-type is generic or missing
	if (!contentType || (media.type === "text" && media.subtype === "plain")) {
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

const BINARY_ESSENCES: ReadonlySet<string> = new Set([
	"application/octet-stream",
	"application/zip",
	"application/gzip",
]);

/**
 * What the Content-Type alone says the body is, compared by whole token
 * (#2458). The order is the meaning: SVG is checked before `image/` so it
 * reads and formats as the XML it is, which is also what the engine sends it
 * as.
 */
function declaredBodyType({ type, subtype, name, suffix }: MediaType): BodyType | undefined {
	const essence = `${type}/${subtype}`;
	if (essence === "image/svg+xml") return "xml";
	if (type === "image") return "image";
	if (essence === "application/pdf") return "pdf";
	if (name === "json" || suffix === "json") return "json";
	if (name === "javascript") return "javascript";
	if (essence === "text/css") return "css";
	if (essence === "text/html" || name === "xhtml") return "html";
	if (name === "xml" || suffix === "xml") return "xml";
	if (essence === "text/markdown") return "markdown";
	if (BINARY_ESSENCES.has(essence)) return "binary";
	return undefined;
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
 * Past this much body, the pane stops formatting and shows a raw prefix.
 *
 * Nothing about a response this size is free on the main thread, and rendering
 * one costs synchronous passes over the whole string plus a Monaco model: the
 * type sniff, the indent pass (a copy larger than the input) and Monaco
 * tokenising the result line by line for syntax highlighting. There is no
 * worker to move them to - `formatBody` is called during render - so all of it
 * lands between the user pressing Send and the pane painting.
 *
 * 2MB is where that stops being a pause and starts being a freeze, and it is
 * far above any body a person reads in an editor: 2MB of JSON is roughly 50,000
 * formatted lines. The engine's own design-mode read bound
 * (`maxDesignResponseBodyBytes`) is 32MB, sixteen times this, precisely because
 * *keeping* bytes is cheap where *formatting* them is not - the two numbers
 * answer different questions and are deliberately not the same.
 *
 * Characters, not bytes, because that is what the editor and `String.slice`
 * count; for anything but a body of astral-plane text the two agree closely
 * enough for a display threshold.
 */
export const LARGE_BODY_BYTES = 2 * 1024 * 1024;

/**
 * Format body for display (pretty print JSON, XML).
 *
 * JSON is indented by `lib/json-format.ts`, which copies the received text
 * token by token rather than parsing it, so member order, repeated keys and
 * integers past 2^53 show as the server sent them (issue #2459). The input is
 * always the received text: a caller holding a parsed object has already lost
 * those, and there is nothing here to format it from.
 *
 * XML is pretty-printed too (`lib/xml-format.ts`). It was detected here and
 * highlighted by Monaco, but never indented, so Pretty and Raw were byte-for-byte
 * identical for every XML response - which reads as the toggle being broken.
 *
 * Only `bodyType === "xml"` reaches the indenter, never the `undefined` fallback
 * the JSON branch also serves: without a declared type, "starts with a tag" is
 * also true of HTML, whose whitespace rules are not XML's.
 */
export function formatBody(body: string | undefined, bodyType?: BodyType): string {
	if (!body) return "";
	if (bodyType === "json" || bodyType === undefined) return formatJson(body);
	// Returns its input unchanged when the document cannot be walked, so a
	// malformed response still renders as what arrived.
	if (bodyType === "xml") return formatXml(body);
	return body;
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
 * What `timing.engineMs` counts, worded once for the status bar's hover and the
 * Timing tab's tip (#2132). It must stay a statement of scope: the figure is
 * not a verdict on anyone else's speed, and `queueWaitMs` is a different,
 * smaller thing that is never presented as this.
 */
export const ENGINE_COST_TIP =
	"Time Vayu's engine spent on this send: building the request, auth, cookies and " +
	"assembling the answer. It leaves out the network transfer, your scripts and rendering.";

/** A figure the engine reported: absent, NaN and negative all mean "nothing to show". */
export const isReportedMs = (ms: number | undefined): ms is number =>
	typeof ms === "number" && Number.isFinite(ms) && ms >= 0;

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
 * What the status bar's size counts (#2787). `size` is the decoded body, so a
 * gzipped 12 KB reply that inflates to 80 KB reads as 80 KB; saying so stops it
 * being compared with a DevTools or curl figure that counts something else.
 */
export const RESPONSE_SIZE_TIP =
	"Decoded body size. Headers are not counted, and a compressed response counts " +
	"the bytes after decompression.";

/**
 * The size element's hover: `RESPONSE_SIZE_TIP`, plus the compressed length when
 * the headers show the body was encoded. Content-Length is the wire figure only
 * beside a Content-Encoding other than `identity`; alone it is the body itself.
 */
export function responseSizeTip(headers: Record<string, string> | undefined): string {
	const encoding = headerValueOf(headers, "content-encoding").trim().toLowerCase();
	const length = headerValueOf(headers, "content-length").trim();
	if (!encoding || encoding === "identity" || !/^\d+$/.test(length)) return RESPONSE_SIZE_TIP;
	return `${RESPONSE_SIZE_TIP} ${formatSize(Number(length))} on the wire.`;
}

/**
 * Rebuild the raw HTTP request from the parts a stored trace keeps.
 *
 * A live send gets `rawRequest` from the engine, which assembles the real wire
 * message (`Client::send`, engine/src/http/client.cpp:277-331). A restored one has
 * no such string - the trace stores method, url, headers and body separately -
 * and the restore path used to collapse all four into `${method} ${url}`, so
 * the Raw tab of a reopened run showed a single line and the body that was sent
 * was not reachable anywhere in the app.
 *
 * This follows the engine's order so the two read the same: request line with
 * the path, `Host` from the URL, the sent headers, `Content-Length` for a body,
 * blank line, body.
 *
 * `httpVersion` is the negotiated protocol as a *display* string (`"HTTP/2"`,
 * `"HTTP/1.1"`, or `""` when nothing was negotiated - the engine's convention,
 * see `Response::http_version` in `engine/src/http/client.cpp`) - never the
 * request-side `auto`/`http1.1`/`http2` union; do not pass that here. It
 * defaults to `"HTTP/1.1"` so callers that predate this parameter, and stored
 * runs from before the field existed, keep printing what they always did.
 *
 * An explicit `""` collapses to the same default. The engine's own rawRequest
 * builder falls back to the *requested* protocol in that case (it has
 * `request.http_version` in hand); this generic formatter only ever sees a
 * display string, so replicating that fallback here would mean threading the
 * requested union into a function whose contract is display-string-only -
 * exactly the value-space merge this field's docs elsewhere warn against.
 */
export function buildRawRequest(
	method: string,
	url: string,
	headers: Record<string, string> = {},
	body?: string,
	httpVersion: string = "HTTP/1.1"
): string {
	let target = url;
	let host = "";
	try {
		const parsed = new URL(url);
		target = `${parsed.pathname}${parsed.search}` || "/";
		host = parsed.host;
	} catch {
		// A URL the platform will not parse - a host with no scheme, or one
		// still holding an unresolved {{variable}}. Keep the string whole rather
		// than inventing a split, and let the Host header fall away with it.
	}

	const versionLabel = httpVersion || "HTTP/1.1";
	let raw = `${method || "GET"} ${target} ${versionLabel}\r\n`;
	if (host) raw += `Host: ${host}\r\n`;

	for (const [key, value] of Object.entries(headers)) {
		// Host comes from the URL above; printing it twice is a protocol error.
		if (key.toLowerCase() === "host") continue;
		raw += `${key}: ${value}\r\n`;
	}

	// Bytes, not characters - the engine counts `content.size()`, and any
	// non-ASCII in the body makes the two differ.
	if (body) raw += `Content-Length: ${new TextEncoder().encode(body).length}\r\n`;

	raw += "\r\n";
	if (body) raw += body;

	return raw;
}

/**
 * Build raw HTTP response string.
 *
 * `httpVersion` is the negotiated protocol as a display string - see
 * `buildRawRequest`'s doc comment above for the full contract, including why
 * `""` (the engine's "nothing negotiated" convention) collapses to the same
 * `"HTTP/1.1"` default as an omitted argument rather than trying to recover
 * the requested protocol.
 *
 * `headers` is the lines as received (issue #2460) - one line each, in wire
 * order, the name in the server's case - or, for a caller with only the folded
 * map, that map's entries. The lines are what the tab should print: it is the
 * exchange as the server sent it, and the map has lowercased every name and
 * joined every repeat into one.
 */
export function buildRawResponse(
	status: number,
	statusText: string,
	headers: Record<string, string> | HeaderLine[],
	body: string,
	httpVersion: string = "HTTP/1.1"
): string {
	const versionLabel = httpVersion || "HTTP/1.1";
	let raw = `${versionLabel} ${status} ${statusText}\r\n`;

	for (const { name, value } of Array.isArray(headers)
		? headers
		: resolveHeaderLines(headers, undefined)) {
		raw += `${name}: ${value}\r\n`;
	}

	// Empty line between headers and body
	raw += "\r\n";

	// Add body
	if (body) {
		raw += body;
	}

	return raw;
}
