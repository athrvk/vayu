/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/** One header line as it was written, name and value. */
export type HeaderLine = readonly [name: string, value: string];

/**
 * The request's header lines as they went out, in wire order, read off the
 * engine's recorded frame (`rawRequest`): `Host`, `Accept`, `Content-Length`,
 * the jar's `Cookie` and the author's own rows alike.
 *
 * Read from the frame rather than reported because the frame is the only place
 * the engine states all of them (issue #2464): `requestHeaders` is the sent
 * record, which holds what Vayu composed, and the transport writes lines of its
 * own after that.
 *
 * A list of lines, not a map: a repeated name is a repeated line on the wire,
 * and a map would keep one of them. Names keep the spelling the frame used.
 *
 * Pass only a frame the engine recorded. `buildRawRequest` fabricates a `Host`
 * and a `Content-Length` for a stored row that has no frame, and parsing that
 * would list lines that never went on a wire; the funnels guard that
 * (`wireRequestHeadersField`).
 */
export function parseWireHeaders(rawRequest: string | undefined): HeaderLine[] {
	if (!rawRequest) return [];

	const lines: [string, string][] = [];
	// The line a continuation extends: the last one read, unless a line that is
	// not a header came between.
	let open: [string, string] | undefined;
	// The first line is the request line; the first blank one ends the header
	// block, and what follows is a body that may look like headers.
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
 * `ResponseState.wireRequestHeaders` for one exchange, as a spread so an empty
 * list stays an absent key and both funnels build the same state.
 *
 * `received` is false for a send that failed: the engine writes a synthesized
 * frame when nothing was sent (a refused connection, a DNS failure), and its
 * `Host` and `Content-Length` lines were never on a wire.
 */
export function wireRequestHeadersField(
	received: boolean,
	rawRequest: string | undefined
): { wireRequestHeaders?: HeaderLine[] } {
	if (!received) return {};
	const lines = parseWireHeaders(rawRequest);
	return lines.length > 0 ? { wireRequestHeaders: lines } : {};
}
