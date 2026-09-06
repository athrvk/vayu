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

import type { KeyValueItem } from "@/types";
import { generateId } from "@/lib/id";
import { splitKeyValueLine, stripDisabledMarker, HEADER_SEPARATORS } from "./kv-line";

/**
 * Format headers array to text format for bulk edit
 * Format: "Header-Name: value" (one per line); a disabled row is prefixed
 * `// ` (issue #1480) - the one marker the text form has for a state the
 * table already shows as an unticked checkbox.
 *
 * Every row the table holds is offered: there is no protected version row to
 * hide since issue #1229, and what the engine adds is not in this list at all.
 */
export const formatHeadersToText = (headers: KeyValueItem[]): string => {
	return headers
		.filter((h) => h.key.trim() || h.value.trim())
		.map((h) => `${h.enabled ? "" : "// "}${h.key}: ${h.value}`)
		.join("\n");
};

/**
 * Split one line at whichever of `:` or `=` comes first.
 *
 * A header name may contain neither, so the earliest of the two is always the
 * separator - which is why this cannot simply be shared with the params parser,
 * whose keys *may* contain a colon. See `kv-line.ts` for the rule both follow.
 *
 * Returns null when the line carries neither, or when the separator is the first
 * character - `: value` names no header, and writing an empty key into the table
 * would produce a row the user cannot identify.
 */
const splitHeaderLine = (line: string): { key: string; value: string } | null =>
	splitKeyValueLine(line, HEADER_SEPARATORS);

/**
 * Parse text format to headers array
 * Format: "Header-Name: value" (one per line); "Header-Name=value" also
 * accepted; a leading `// ` disables the row (issue #1480).
 *
 * Every row is rebuilt fresh, so a `source` marker (issue #1481) on a row that
 * passes through Bulk Edit is dropped, matched or not: the text form is the
 * user restating every row by hand, which is not different from retyping one
 * in the table.
 *
 * @param text - Headers in text format
 * @returns Array of KeyValueItem
 */
export const parseHeadersFromText = (text: string): KeyValueItem[] => {
	const lines = text.split("\n").filter((line) => line.trim());
	const headers: KeyValueItem[] = [];

	lines.forEach((line) => {
		const { enabled, rest } = stripDisabledMarker(line);
		const parsed = splitHeaderLine(rest);
		if (!parsed) return;

		headers.push({
			id: generateId(),
			key: parsed.key,
			value: parsed.value,
			enabled,
		});
	});

	return headers;
};

/**
 * Whether committing `text` would change nothing about `headers` (issue
 * #1480) - opening Bulk edit and pressing Table with no typing must not
 * re-enable every row, retype every value through the trim, or dirty the
 * request. Compares by content, not by text: both sides are normalised the
 * same way `formatHeadersToText`/`parseHeadersFromText` already would, so an
 * incidental difference in spacing or row order that the round trip itself
 * would erase does not count as a change.
 */
export const isNoOpHeadersEdit = (text: string, headers: KeyValueItem[]): boolean => {
	const normalize = (list: KeyValueItem[]) =>
		list
			.filter((h) => h.key.trim() || h.value.trim())
			.map(({ key, value, enabled }) => ({ key, value, enabled }));
	return (
		JSON.stringify(normalize(parseHeadersFromText(text))) === JSON.stringify(normalize(headers))
	);
};
