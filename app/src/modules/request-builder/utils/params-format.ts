/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/** Converting between params rows and Bulk Edit text. */

import type { KeyValueItem } from "@/types";
import { generateId } from "@/lib/id";
import { carryIds } from "@/components/shared/KeyValueEditor/key-value";
import {
	scanKeyValueLines,
	unreadLinesOf,
	PARAM_SEPARATORS,
	type ScannedLine,
	type UnreadLine,
} from "./kv-line";
import { queryRowsOf } from "./path-variables";
import { writesBareKey } from "./url";

/**
 * Params as Bulk Edit text: `key=value` per line, a disabled row prefixed `// ` (#1480), as Headers
 * does. Query rows only: a path row (#1764) belongs to the URL's `:name` segments, not a line.
 */
export const formatParamsToText = (params: KeyValueItem[]): string => {
	return (
		queryRowsOf(params)
			// Empty rows are not offered for editing.
			.filter((p) => p.key.trim() || p.value.trim())
			// Spelled as `buildUrlWithParams` sends it: a valueless row as bare `page`, an empty
			// value as `page=`.
			.map(
				(p) =>
					`${p.enabled ? "" : "// "}${writesBareKey(p) ? p.key : `${p.key}=${p.value}`}`
			)
			.join("\n")
	);
};

/** Every non-blank line, read by the one rule the parser and the unread report share. */
const scanParamLines = (text: string): ScannedLine[] =>
	scanKeyValueLines(text, PARAM_SEPARATORS, { allowBareKey: true });

/**
 * The lines `parseParamsFromText` drops, with 1-based line numbers (blank lines counted, not
 * reported), so a commit can say so (#3694). `=novalue` names no key; a bare word is a valueless
 * param, not unread.
 */
export const unreadParamLines = (text: string): UnreadLine[] => unreadLinesOf(scanParamLines(text));

/**
 * Bulk Edit text as params: `key=value` per line, `key: value` accepted when the line has no `=`,
 * so a pasted header block parses; a leading `// ` disables the row (#1480). `page` is a
 * `valueless` row (`?page`), `page=` an empty value (`?page=`). A line restating a row of
 * `previous` (same key, value and `=`) keeps its id, each row once: `buildUrlWithParams` reads the
 * id to tell a carried row from an edited one (#1771), so a bulk commit edits only changed lines.
 *
 * @param text - Params in text format
 * @param previous - The rows the text was formatted from, if any
 * @returns Array of KeyValueItem
 */
export const parseParamsFromText = (
	text: string,
	previous: readonly KeyValueItem[] = []
): KeyValueItem[] => {
	const params: KeyValueItem[] = [];

	for (const { parsed, enabled } of scanParamLines(text)) {
		if (!parsed) continue;
		params.push({
			id: generateId(),
			key: parsed.key,
			value: parsed.value,
			enabled,
			...(parsed.valueless && { valueless: parsed.valueless }),
		});
	}

	// The `//` marker is no part of what a line restates: toggling a row off in text keeps its id.
	return carryIds(
		queryRowsOf(previous),
		params,
		(p, row) =>
			p.key === row.key &&
			p.value === row.value &&
			writesBareKey(p) === (row.valueless === true)
	);
};

/**
 * Whether committing `text` changes nothing about the enabled query `params` (#1480),
 * `isNoOpHeadersEdit`'s rule; path rows never count.
 */
export const isNoOpParamsEdit = (text: string, params: KeyValueItem[]): boolean => {
	const normalize = (list: KeyValueItem[]) =>
		queryRowsOf(list)
			.filter((p) => p.key.trim() || p.value.trim())
			.map((p) => ({
				key: p.key,
				value: p.value,
				enabled: p.enabled,
				bare: writesBareKey(p),
			}));
	return (
		JSON.stringify(normalize(parseParamsFromText(text))) === JSON.stringify(normalize(params))
	);
};
