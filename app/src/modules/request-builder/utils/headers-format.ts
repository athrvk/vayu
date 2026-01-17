
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Headers Format Utilities
 *
 * Utilities for converting between headers array and text format
 */

import type { KeyValueItem } from "../types";
import { generateId } from "./id";
import { VERSION_HEADER_KEY } from "./system-headers";

/**
 * Format headers array to text format for bulk edit
 * Format: "Header-Name=value" (one per line)
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
		.map((h) => `${h.key}=${h.value}`)
		.join("\n");
};

/**
 * Parse text format to headers array
 * Format: "Header-Name: value" (one per line)
 *
 * @param text - Headers in text format
 * @param skipVersion - Whether to skip version header (protected)
 * @returns Array of KeyValueItem
 */
export const parseHeadersFromText = (text: string, skipVersion: boolean = true): KeyValueItem[] => {
	const lines = text.split("\n").filter((line) => line.trim());
	const headers: KeyValueItem[] = [];

	lines.forEach((line) => {
		const match = line.match(/^([^=]+)=\s*(.*)$/);
		if (match) {
			const key = match[1].trim();
			const value = match[2].trim();
			const keyLower = key.toLowerCase();

			// Skip version header if protected
			if (skipVersion && keyLower === VERSION_HEADER_KEY) {
				return;
			}

			headers.push({
				id: generateId(),
				key,
				value,
				enabled: true,
			});
		}
	});

	return headers;
};
