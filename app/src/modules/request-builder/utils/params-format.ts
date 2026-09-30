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
import { splitKeyValueLine, stripDisabledMarker, PARAM_SEPARATORS } from "./kv-line";
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
			.filter((p) => {
				// Filter out empty params and system params
				const hasContent = p.key.trim() || p.value.trim();
				return hasContent && !p.system;
			})
			// Each line is spelled the way `buildUrlWithParams` sends it: a
			// valueless row as a bare `page`, an empty value as `page=`.
			.map(
				(p) =>
					`${p.enabled ? "" : "// "}${writesBareKey(p) ? p.key : `${p.key}=${p.value}`}`
			)
			.join("\n")
	);
};

/**
 * Parse text format to params array
 * Format: "key=value" (one per line); "key: value" is accepted when the line
 * carries no `=`, so a header block pasted here parses instead of vanishing.
 * A leading `// ` disables the row (issue #1480).
 *
 * Two kinds of line used to be dropped in silence. `Authorization: Bearer abc`
 * has no `=`, so pasting a header block returned an empty array - which the
 * panel then wrote over the user's params. And `page`, a legal valueless
 * parameter, matched nothing either, so bulk-editing lost it. It is now a
 * `valueless` row (`?page`), where `page=` is an empty value (`?page=`).
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
	const lines = text.split("\n").filter((line) => line.trim());
	const params: KeyValueItem[] = [];
	const carried = queryRowsOf(previous).filter((p) => !p.system);
	const consumed = new Array<boolean>(carried.length).fill(false);
	const idFor = (key: string, value: string, valueless: boolean): string => {
		const match = carried.findIndex(
			(p, i) =>
				!consumed[i] && p.key === key && p.value === value && writesBareKey(p) === valueless
		);
		if (match === -1) return generateId();
		consumed[match] = true;
		return carried[match].id;
	};

	lines.forEach((line) => {
		const { enabled, rest } = stripDisabledMarker(line);
		const parsed = splitKeyValueLine(rest, PARAM_SEPARATORS, { allowBareKey: true });
		if (!parsed) return;

		params.push({
			id: idFor(parsed.key, parsed.value, parsed.valueless === true),
			key: parsed.key,
			value: parsed.value,
			enabled,
			...(parsed.valueless && { valueless: parsed.valueless }),
		});
	});

	return params;
};

/**
 * Whether committing `text` would change nothing about the enabled, non-system
 * query `params` (issue #1480) - see `isNoOpHeadersEdit`, same rule. Path rows
 * are not what the text describes, so they never make an edit look like one.
 */
export const isNoOpParamsEdit = (text: string, params: KeyValueItem[]): boolean => {
	const normalize = (list: KeyValueItem[]) =>
		queryRowsOf(list)
			.filter((p) => (p.key.trim() || p.value.trim()) && !p.system)
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
