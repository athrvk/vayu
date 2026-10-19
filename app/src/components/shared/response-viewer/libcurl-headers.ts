/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The request header lines libcurl wrote on its own (`Host`, `Accept`,
 * `Content-Length`, the jar's `Cookie`), read off the engine's wire frame
 * (`rawRequest`) as the names that are not in the sent record (`requestHeaders`).
 *
 * Derived rather than reported because the frame is the only place the engine
 * states them (issue #2464): `requestHeaders` is what Vayu composed, and
 * `rawRequest` is what went out. Names compare case-insensitively - the frame
 * may spell `Content-type` where the map says `content-type`, and HTTP/2
 * sends lowercase - and the first spelling and value of a repeated name wins.
 *
 * Pass only a frame the engine recorded. `buildRawRequest` fabricates a `Host`
 * and a `Content-Length` for a stored row that has no frame, and parsing that
 * would list lines the engine never reported; the funnels guard that
 * (`restore-response.ts`'s `sentSide`).
 */
export function libcurlAddedHeaders(
	rawRequest: string | undefined,
	requestHeaders: Record<string, string> | undefined
): Record<string, string> {
	if (!rawRequest) return {};

	const sent = new Set(Object.keys(requestHeaders ?? {}).map((name) => name.toLowerCase()));
	// Keyed by lowercase name: the first line of a name wins, and the entry a
	// continuation line extends is the last one opened.
	const added = new Map<string, [name: string, value: string]>();
	let open: [string, string] | undefined;

	// The first line is the request line; the first blank one ends the header
	// block, and what follows is a body that may look like headers.
	const [, ...lines] = rawRequest.split(/\r?\n/);
	for (const line of lines) {
		if (line === "") break;

		// A line starting with whitespace continues the previous value.
		if (/^[ \t]/.test(line)) {
			if (open) open[1] += ` ${line.trim()}`;
			continue;
		}

		open = undefined;
		const colon = line.indexOf(":");
		const name = colon > 0 ? line.slice(0, colon).trim() : "";
		const key = name.toLowerCase();
		if (!name || sent.has(key) || added.has(key)) continue;

		open = [name, line.slice(colon + 1).trim()];
		added.set(key, open);
	}
	return Object.fromEntries(added.values());
}

/**
 * `ResponseState.libcurlHeaders` for one exchange, as a spread so an empty group
 * stays an absent key and both funnels build the same state.
 *
 * `received` is false for a send that failed: the engine writes a synthesized
 * frame when libcurl sent nothing (a refused connection, a DNS failure), and
 * its `Host` and `Content-Length` lines were never on a wire.
 */
export function libcurlHeadersField(
	received: boolean,
	rawRequest: string | undefined,
	requestHeaders: Record<string, string> | undefined
): { libcurlHeaders?: Record<string, string> } {
	if (!received) return {};
	const added = libcurlAddedHeaders(rawRequest, requestHeaders);
	return Object.keys(added).length > 0 ? { libcurlHeaders: added } : {};
}
