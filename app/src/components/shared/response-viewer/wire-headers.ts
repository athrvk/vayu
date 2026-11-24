/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/** One header line as it was written, name and value. */
export type HeaderLine = readonly [name: string, value: string];

/**
 * The request's header lines as they went out, in wire order, read off the engine's recorded frame
 * (`rawRequest`): `Host`, `Accept`, `Content-Length`, the jar's `Cookie` and the author's rows
 * alike. From the frame, as only it states all of them (#2464): `requestHeaders` is the sent record
 * of what Vayu composed, and the transport writes its own lines after. Lines, not a map: a repeated
 * name is a repeated wire line a map would collapse; names keep the frame's spelling. Pass only a
 * recorded frame: `buildRawRequest` fabricates `Host` and `Content-Length` for a frameless stored
 * row, lines that never went on a wire (the funnels guard this, `wireRequestHeadersField`).
 */
export function parseWireHeaders(rawRequest: string | undefined): HeaderLine[] {
	if (!rawRequest) return [];

	const lines: [string, string][] = [];
	// The line a continuation extends: the last read, unless a non-header line came between.
	let open: [string, string] | undefined;
	// The first line is the request line; the first blank ends the headers, and what follows is a
	// body that may look like them.
	const [, ...head] = rawRequest.split(/\r?\n/);
	for (const line of head) {
		if (line === "") break;

		// A line starting with whitespace continues the previous value.
		if (/^[ \t]/.test(line)) {
			if (open) open[1] += ` ${line.trim()}`;
			continue;
		}

		const colon = line.indexOf(":");
		const name = colon > 0 ? line.slice(0, colon).trim() : "";
		open = name ? [name, line.slice(colon + 1).trim()] : undefined;
		if (open) lines.push(open);
	}
	return lines;
}

/**
 * `ResponseState.wireRequestHeaders` for one exchange, a spread so an empty list stays an absent
 * key and both funnels agree. `received` is false for a failed send: the engine writes a
 * synthesized frame when nothing was sent (a refused connection, a DNS failure), whose `Host` and
 * `Content-Length` never reached a wire.
 */
export function wireRequestHeadersField(
	received: boolean,
	rawRequest: string | undefined
): { wireRequestHeaders?: HeaderLine[] } {
	if (!received) return {};
	const lines = parseWireHeaders(rawRequest);
	return lines.length > 0 ? { wireRequestHeaders: lines } : {};
}
