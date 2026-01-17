
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

/**
 * Format params array to text format for bulk edit
 * Format: "key=value" (one per line)
 */
export const formatParamsToText = (params: KeyValueItem[]): string => {
	return params
		.filter((p) => {
			// Filter out empty params and system params
			const hasContent = p.key.trim() || p.value.trim();
			return hasContent && !p.system;
		})
		.map((p) => `${p.key}=${p.value}`)
		.join("\n");
};

/**
 * Parse text format to params array
 * Format: "key=value" (one per line)
 *
 * @param text - Params in text format
 * @returns Array of KeyValueItem
 */
export const parseParamsFromText = (text: string): KeyValueItem[] => {
	const lines = text.split("\n").filter((line) => line.trim());
	const params: KeyValueItem[] = [];

	lines.forEach((line) => {
		const match = line.match(/^([^=]+)=\s*(.*)$/);
		if (match) {
			const key = match[1].trim();
			const value = match[2].trim();

			params.push({
				id: generateId(),
				key,
				value,
				enabled: true,
			});
		}
	});

	return params;
};
