/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Params Format Utilities
 *
 * Utilities for converting between params array and text format for bulk edit
 */

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
 * Format params array to text format for bulk edit
 * Format: "key=value" (one per line); a disabled row is prefixed `// `
 * (issue #1480), the same marker the Headers tab uses.
 *
 * Query rows only: the bulk editor edits the query table, and a path row
 * (issue #1764) belongs to the URL's `:name` segments, not to a `key=value` line.
 */
export const formatParamsToText = (params: KeyValueItem[]): string => {
	return (
		queryRowsOf(params)
			// Empty rows are not offered for editing.
			.filter((p) => p.key.trim() || p.value.trim())
			// Each line is spelled the way `buildUrlWithParams` sends it: a
			// valueless row as a bare `page`, an empty value as `page=`.
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
 * The lines `parseParamsFromText` drops, with their 1-based line numbers (blank
 * lines count but are not reported), so a commit can say what it did not read
 * (#3694). `=novalue` names no key; a bare word is a valueless param, not unread.
 */
export const unreadParamLines = (text: string): UnreadLine[] => unreadLinesOf(scanParamLines(text));

/**
 * Parse text format to params array
 * Format: "key=value" (one per line); "key: value" is accepted when the line
 * carries no `=`, so a header block pasted here parses instead of vanishing.
 * A leading `// ` disables the row (issue #1480).
 *
 * `page`, a legal valueless parameter, is a `valueless` row (`?page`), where
 * `page=` is an empty value (`?page=`).
 *
 * A line that restates a row of `previous` (same key, value and `=`) keeps that
 * row's id, each row once. `buildUrlWithParams` reads the id to tell a row
 * carried over from one the user edited (issue #1771), and a bulk commit edits
 * only the lines that changed.
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

	// The `//` marker is not part of what a line restates: toggling a row off
	// in the text keeps its id.
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
 * Whether committing `text` would change nothing about the enabled
 * query `params` (issue #1480) - see `isNoOpHeadersEdit`, same rule. Path rows
 * are not what the text describes, so they never make an edit look like one.
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
