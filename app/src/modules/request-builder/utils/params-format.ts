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

import type { KeyValueItem } from "../types";
import { generateId } from "./id";
import { splitKeyValueLine, PARAM_SEPARATORS } from "./kv-line";

/**
 * Format params array to text format for bulk edit
 * Format: "key=value" (one per line)
 */
export const formatParamsToText = (params: KeyValueItem[]): string => {
	return (
		params
			.filter((p) => {
				// Filter out empty params and system params
				const hasContent = p.key.trim() || p.value.trim();
				return hasContent && !p.system;
			})
			// A valueless param writes as a bare key, matching how it is sent:
			// `buildUrlWithParams` emits `?page`, not `?page=`. Writing `page=` here
			// round-tripped, but told the user something the request does not do.
			.map((p) => (p.value ? `${p.key}=${p.value}` : p.key))
			.join("\n")
	);
};

/**
 * Parse text format to params array
 * Format: "key=value" (one per line); "key: value" is accepted when the line
 * carries no `=`, so a header block pasted here parses instead of vanishing.
 *
 * Two kinds of line used to be dropped in silence. `Authorization: Bearer abc`
 * has no `=`, so pasting a header block returned an empty array - which the
 * panel then wrote over the user's params. And `page`, a legal valueless
 * parameter that `buildUrlWithParams` already emits as `?page`, matched nothing
 * either, so bulk-editing lost it.
 *
 * @param text - Params in text format
 * @returns Array of KeyValueItem
 */
export const parseParamsFromText = (text: string): KeyValueItem[] => {
	const lines = text.split("\n").filter((line) => line.trim());
	const params: KeyValueItem[] = [];

	lines.forEach((line) => {
		const parsed = splitKeyValueLine(line, PARAM_SEPARATORS, { allowBareKey: true });
		if (!parsed) return;

		params.push({
			id: generateId(),
			key: parsed.key,
			value: parsed.value,
			enabled: true,
		});
	});

	return params;
};
