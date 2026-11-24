/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Response body type detection and formatting, and the viewers' shared time, size and raw-message
 * helpers.
 */

import { formatBytes, formatFixed, formatLatencyParts } from "@/lib/format-number";
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

/** The body type from headers, then content. */
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
 * What the Content-Type alone says the body is, compared by whole token (#2458). The order is the
 * meaning: SVG before `image/`, so it reads and formats as the XML it is, as the engine sends it.
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

/** The Monaco language for a body type. */
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
 * Past this much body, the pane stops formatting and shows a raw prefix. A body this size costs
 * synchronous passes over the whole string plus a Monaco model: the type sniff, the indent pass (a
 * copy larger than the input) and Monaco tokenising for highlighting. `formatBody` runs in render,
 * with no worker to move it to, so all of it lands between Send and the pane painting. 2MB is where
 * a pause becomes a freeze, far above a body anyone reads in an editor (about 50,000 formatted JSON
 * lines). The engine's design-mode read bound (`maxDesignResponseBodyBytes`) is 32MB, as *keeping*
 * bytes is cheap where *formatting* is not: different questions, deliberately different numbers.
 * The Raw tab (`RawRequestResponse`) caps at the same number: unformatted, it still hands Monaco
 * the whole exchange as one model plus `markLines` and `buildRawResponse` passes, the same freeze;
 * it shows the prefix and the same notice. Characters, not bytes, as the editor and `String.slice`
 * count them; outside astral-plane text the two agree well enough for a display threshold.
 */
export const LARGE_BODY_BYTES = 2 * 1024 * 1024;

/**
 * The body formatted for display. JSON is indented by `lib/json-format.ts`, which copies the
 * received text token by token rather than parsing it, so member order, repeated keys and integers
 * past 2^53 stay as sent (#2459); the input is always the received text, a parsed object having
 * lost those. XML is indented too (`lib/xml-format.ts`), or Pretty and Raw would be identical for
 * every XML response, reading as a broken toggle. Only `bodyType === "xml"` reaches that indenter,
 * never the `undefined` fallback the JSON branch serves: without a declared type, "starts with a
 * tag" is true of HTML, whose whitespace rules are not XML's.
 */
export function formatBody(body: string | undefined, bodyType?: BodyType): string {
	if (!body) return "";
	if (bodyType === "json" || bodyType === undefined) return formatJson(body);
	// It returns its input unchanged when the document cannot be walked, so a malformed response
	// still renders as received.
	if (bodyType === "xml") return formatXml(body);
	return body;
}

/**
 * Response time at a readable precision: four decimals of a millisecond (`340.1235 ms`) sit far
 * below the measurement's resolution, the last digits noise that makes the number people scan
 * longer and harder to compare between runs. The digits are the load surfaces'
 * (`formatLatencyParts`, #2793): two decimals below 10 ms, whole milliseconds above, so a 2.27 ms
 * send reads `2.27 ms` here and as a load p50. Here, shared, because a fix to one viewer's copy
 * missed the other.
 */
export function formatResponseTime(ms: number): string {
	const { value, unit } = formatDuration(ms);
	return `${value} ${unit}`;
}

/**
 * What `timing.engineMs` counts, worded once for the status bar's hover and the Timing tab's tip
 * (#2132). It stays a statement of scope: no verdict on anyone else's speed, and `queueWaitMs`, a
 * smaller, different thing, is never presented as it.
 */
export const ENGINE_COST_TIP =
	"Time Vayu's engine spent on this send: building the request, auth, cookies and " +
	"assembling the answer. It leaves out the network transfer, your scripts and rendering.";

/**
 * What `timing.scriptMs` counts, for the status bar's hover and the Timing tab's tip (#3676): the
 * other half of what `ENGINE_COST_TIP` says the engine leaves out, so both name one boundary:
 * scripts here, never in "Vayu", neither added to the total.
 */
export const SCRIPT_TIME_TIP =
	"Time your pre-request and test scripts took on this send, including any " +
	"pm.sendRequest calls. It is counted apart from the network transfer, Vayu's own time and the total.";

/** A figure the engine reported: absent, NaN and negative all mean "nothing to show". */
export const isReportedMs = (ms: number | undefined): ms is number =>
	typeof ms === "number" && Number.isFinite(ms) && ms >= 0;

const isReportedEpoch = (ms: number | undefined): ms is number =>
	typeof ms === "number" && Number.isFinite(ms);

/**
 * Milliseconds from @p from to @p to, both epoch ms, or undefined when either is unknown (#3775): a
 * load run's sampled event has no `receivedAt`, and a stream restored in a later session has no
 * send time. Floored at 0: a stream's send time is stamped by the renderer when the engine's `202`
 * lands, so a local upstream's first event can be a few ms earlier.
 */
export function elapsedBetween(
	from: number | undefined,
	to: number | undefined
): number | undefined {
	if (!isReportedEpoch(from) || !isReportedEpoch(to)) return undefined;
	return Math.max(0, to - from);
}

/**
 * A duration as number and unit, so the unit can be styled apart (smaller, `subtle-foreground`).
 * For independent values (a total, a queue wait), by `formatLatencyParts`, every load surface's
 * rule: seconds all the way up, no minutes. Values read against each other use
 * `formatPhaseDuration`, which keeps more precision in the tens of milliseconds.
 */
export function formatDuration(ms: number): { value: string; unit: DurationUnit } {
	return formatLatencyParts(ms);
}

/**
 * A timing phase (DNS, connect, TLS, first byte, download), always in ms, by significant digits:
 * the five share a scale and not magnitudes (a cached DNS lookup is 0.04ms, first byte routinely
 * 300ms), so one fixed precision is wrong at one end. The one implementation for the dashboard, the
 * history breakdown and the request builder's timing tab, which had three answers for the same
 * numbers. Not `formatResponseTime`, which describes a whole response and switches to seconds; a
 * phase is sub-second in practice, and comparing across a row matters more than the unit.
 */
export function formatPhaseMs(ms: number): string {
	if (ms >= 100) return formatFixed(ms, 0);
	if (ms >= 10) return formatFixed(ms, 1);
	return formatFixed(ms, 2);
}

export type DurationUnit = "ms" | "s";

/**
 * A timing phase as number and unit: `formatDuration`'s unit rule (ms until a second, then seconds)
 * with the significant-digit ladder above, as a phase needs precision `formatDuration` lacks
 * (0.04ms DNS, a 47.83ms connect keeping its decimal where it prints `48`). Each value picks its
 * own unit: one unit across the row turned a 262ms connect into `0.26 s` and a 0.96ms download into
 * `0.00 s`, while a millisecond reads fine alone and the percentage column carries the comparison.
 */
export function formatPhaseDuration(ms: number): { value: string; unit: DurationUnit } {
	if (ms < 1000) return { value: formatPhaseMs(ms), unit: "ms" };
	return { value: formatFixed(ms / 1000, 2), unit: "s" };
}

/**
 * What the status bar's size counts (#2787): the decoded body, so a gzipped 12 KB reply inflating
 * to 80 KB reads 80 KB; saying so stops comparison with a DevTools or curl figure counting
 * something else.
 */
export const RESPONSE_SIZE_TIP =
	"Decoded body size. Headers are not counted, and a compressed response counts " +
	"the bytes after decompression.";

/**
 * The size's hover: `RESPONSE_SIZE_TIP`, plus the compressed length when the headers show an
 * encoding; Content-Length is the wire figure only beside a Content-Encoding other than `identity`,
 * alone it is the body.
 */
export function responseSizeTip(headers: Record<string, string> | undefined): string {
	const encoding = headerValueOf(headers, "content-encoding").trim().toLowerCase();
	const length = headerValueOf(headers, "content-length").trim();
	if (!encoding || encoding === "identity" || !/^\d+$/.test(length)) return RESPONSE_SIZE_TIP;
	return `${RESPONSE_SIZE_TIP} ${formatBytes(Number(length))} on the wire.`;
}

/**
 * The raw HTTP request rebuilt from a stored trace's parts. A live send gets `rawRequest` from the
 * engine's real wire message (`Client::send`, `engine/src/http/client.cpp`); a restored one has
 * method, url, headers and body apart. Built in the engine's order, so the two read alike: request
 * line with the path, `Host` from the URL, the sent headers, `Content-Length` for a body, blank
 * line, body.
 *
 * `httpVersion` is the negotiated protocol as a *display* string (`"HTTP/2"`, `"HTTP/1.1"`, or `""`
 * when nothing was negotiated, the engine's convention, `Response::http_version` in
 * `engine/src/http/client.cpp`), never the request-side `auto`/`http1.1`/`http2` union; do not pass
 * that here. It defaults to `"HTTP/1.1"`, so callers predating this parameter and runs stored
 * before the field print as before, and an explicit `""` collapses to it: the engine's builder
 * falls back to the *requested* protocol there, but this display-string-only formatter would need
 * the request union threaded in, the value-space merge this field's docs warn against.
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
		// A URL the platform will not parse (no scheme, an unresolved {{variable}}) stays whole
		// rather than split by invention, and the Host header goes with it.
	}

	const versionLabel = httpVersion || "HTTP/1.1";
	let raw = `${method || "GET"} ${target} ${versionLabel}\r\n`;
	if (host) raw += `Host: ${host}\r\n`;

	for (const [key, value] of Object.entries(headers)) {
		// Host comes from the URL above; printing it twice is a protocol error.
		if (key.toLowerCase() === "host") continue;
		raw += `${key}: ${value}\r\n`;
	}

	// Bytes, not characters: the engine counts `content.size()`, and non-ASCII makes the two
	// differ.
	if (body) raw += `Content-Length: ${new TextEncoder().encode(body).length}\r\n`;

	raw += "\r\n";
	if (body) raw += body;

	return raw;
}

/**
 * The raw HTTP response string. `httpVersion` is a display string, by `buildRawRequest`'s contract
 * (`""` collapses to `"HTTP/1.1"` too). `headers` is the lines as received (#2460), one per line in
 * wire order and the server's case, or for a caller with only the folded map, its entries: the
 * lines are the exchange as sent, where the map lowercased every name and joined every repeat.
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
