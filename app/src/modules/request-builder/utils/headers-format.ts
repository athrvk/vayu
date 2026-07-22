/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Headers Format Utilities
 *
 * Text form for the Headers tab's Bulk Edit mode.
 *
 * The canonical separator is a colon - `Header-Name: value` - because that is
 * how HTTP itself writes a header, how every tool the user copies from prints
 * one, and what the panel's own placeholder has always shown.
 *
 * It was not what the parser accepted. `parseHeadersFromText` matched
 * `/^([^=]+)=\s*(.*)$/` and nothing else, so the three lines the placeholder
 * offered as an example - `Authorization: Bearer token` and friends - matched no
 * line at all. A user who followed the placeholder, or pasted real headers from
 * curl or devtools, switched back to Table View and found every header gone.
 * There was no error: unmatched lines are skipped, and skipping all of them
 * produces an empty array, which the panel wrote over the previous headers.
 *
 * Both separators are accepted now, and the *earlier* one in the line wins. That
 * resolves the ambiguous cases the way a reader would: `Authorization: Bearer
 * a=b` splits at the colon (the `=` belongs to the value), `X-Legacy=a:b` splits
 * at the equals, so anything already typed in the old form still round-trips.
 */

import type { KeyValueItem } from "../types";
import { generateId } from "./id";
import { VERSION_HEADER_KEY } from "./system-headers";

/**
 * Format headers array to text format for bulk edit
 * Format: "Header-Name: value" (one per line)
 * Excludes version header since it's protected and can't be edited
 */
export const formatHeadersToText = (headers: KeyValueItem[]): string => {
	return headers
		.filter((h) => {
			// Filter out empty headers and version header
			const hasContent = h.key.trim() || h.value.trim();
			const isVersion = h.key.toLowerCase() === VERSION_HEADER_KEY;
			return hasContent && !isVersion;
		})
		.map((h) => `${h.key}: ${h.value}`)
		.join("\n");
};

/**
 * Split one line at whichever of `:` or `=` comes first.
 *
 * Returns null when the line carries neither, or when the separator is the first
 * character - `: value` names no header, and writing an empty key into the table
 * would produce a row the user cannot identify.
 */
const splitHeaderLine = (line: string): { key: string; value: string } | null => {
	const colon = line.indexOf(":");
	const equals = line.indexOf("=");

	// -1 means absent; pick the smaller of the two positions that exist.
	let at: number;
	if (colon === -1) at = equals;
	else if (equals === -1) at = colon;
	else at = Math.min(colon, equals);

	if (at <= 0) return null;

	const key = line.slice(0, at).trim();
	if (!key) return null;

	return { key, value: line.slice(at + 1).trim() };
};

/**
 * Parse text format to headers array
 * Format: "Header-Name: value" (one per line); "Header-Name=value" also accepted
 *
 * @param text - Headers in text format
 * @param skipVersion - Whether to skip version header (protected)
 * @returns Array of KeyValueItem
 */
export const parseHeadersFromText = (text: string, skipVersion: boolean = true): KeyValueItem[] => {
	const lines = text.split("\n").filter((line) => line.trim());
	const headers: KeyValueItem[] = [];

	lines.forEach((line) => {
		const parsed = splitHeaderLine(line);
		if (!parsed) return;

		// Skip version header if protected
		if (skipVersion && parsed.key.toLowerCase() === VERSION_HEADER_KEY) {
			return;
		}

		headers.push({
			id: generateId(),
			key: parsed.key,
			value: parsed.value,
			enabled: true,
		});
	});

	return headers;
};
