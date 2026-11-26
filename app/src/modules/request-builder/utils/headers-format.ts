/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Text form for the Headers tab's Bulk Edit. The canonical separator is a colon,
 * `Header-Name: value`: how HTTP writes a header, how every tool the user copies from prints one,
 * and what the placeholder shows. Both separators are accepted, the *earlier* in the line winning,
 * which reads ambiguous lines as a person would: `Authorization: Bearer a=b` splits at the colon,
 * `X-Legacy=a:b` at the equals. A line neither form reads is dropped and reported
 * (`unreadHeaderLines`, #3694).
 */

import type { KeyValueItem } from "@/types";
import { generateId } from "@/lib/id";
import {
	scanKeyValueLines,
	unreadLinesOf,
	HEADER_SEPARATORS,
	type ScannedLine,
	type UnreadLine,
} from "./kv-line";

/**
 * Headers as Bulk Edit text: `Header-Name: value` per line, a disabled row prefixed `// ` (#1480),
 * the text form's one marker for the table's unticked checkbox. Every row is offered: what the
 * engine adds is not in this list (#1229).
 */
export const formatHeadersToText = (headers: KeyValueItem[]): string => {
	return headers
		.filter((h) => h.key.trim() || h.value.trim())
		.map((h) => `${h.enabled ? "" : "// "}${h.key}: ${h.value}`)
		.join("\n");
};

/**
 * Every non-blank line, split at whichever of `:` or `=` comes first: a header name may contain
 * neither, so the earliest is always the separator, which is why this is not the params parser,
 * whose keys may contain a colon (`kv-line.ts` has the shared rule). A line with neither, or
 * starting with its separator (`: value` names no header), is unparsed: an empty-key row is one
 * nobody can identify.
 */
const scanHeaderLines = (text: string): ScannedLine[] => scanKeyValueLines(text, HEADER_SEPARATORS);

/**
 * Bulk Edit text as header rows: `Header-Name: value` per line, `Header-Name=value` accepted, a
 * leading `// ` disabling the row (#1480). Every row is rebuilt, so a `source` marker (#1481) does
 * not survive Bulk Edit, matched or not: the text form is the user restating every row by hand.
 *
 * @param text - Headers in text format
 * @returns Array of KeyValueItem
 */
export const parseHeadersFromText = (text: string): KeyValueItem[] => {
	const headers: KeyValueItem[] = [];

	for (const { parsed, enabled } of scanHeaderLines(text)) {
		if (!parsed) continue;
		headers.push({
			id: generateId(),
			key: parsed.key,
			value: parsed.value,
			enabled,
		});
	}

	return headers;
};

/**
 * The lines `parseHeadersFromText` drops, with 1-based line numbers (blank lines counted, not
 * reported), so a commit can say so (#3694).
 */
export const unreadHeaderLines = (text: string): UnreadLine[] =>
	unreadLinesOf(scanHeaderLines(text));

/**
 * Whether committing `text` changes nothing about `headers` (#1480): opening Bulk edit and pressing
 * Table untyped must not re-enable every row, retrim every value or dirty the request. Compared by
 * content, both sides normalised as the format/parse round trip would, so spacing or order the
 * round trip erases is no change.
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
