/**
 * Key-Value Utilities
 *
 * Utilities for working with KeyValueItem arrays
 */

import type { KeyValueItem } from "../types";
import { generateId } from "./id";
import { createDefaultSystemHeaders } from "./system-headers";

/**
 * Create an empty KeyValueItem
 */
export const createEmptyKeyValue = (): KeyValueItem => ({
	id: generateId(),
	key: "",
	value: "",
	enabled: true,
});

/**
 * Convert KeyValueItem[] to Record<string, string>
 * When duplicate keys exist, the last one wins (allows user overrides of system headers)
 */
export const keyValueToRecord = (items: KeyValueItem[]): Record<string, string> => {
	const result: Record<string, string> = {};
	items.forEach((item) => {
		if (item.enabled && item.key.trim()) {
			// Last one wins - allows user headers to override system headers
			result[item.key] = item.value;
		}
	});
	return result;
};

/**
 * Convert Record<string, string> to KeyValueItem[]
 * Only adds system headers when preserveSystemHeaders is true (for headers only, not params)
 */
export const recordToKeyValue = (
	record: Record<string, string> | undefined,
	preserveSystemHeaders: boolean = false
): KeyValueItem[] => {
	const items: KeyValueItem[] = [];

	// Only add system headers for headers, not for params or other key-value pairs
	if (preserveSystemHeaders) {
		const systemHeaders = createDefaultSystemHeaders();
		const systemHeaderKeys = new Set(systemHeaders.map((h) => h.key.toLowerCase()));

		// Add system headers first
		items.push(...systemHeaders);

		// Add loaded items (excluding system headers that are already added)
		if (record) {
			Object.entries(record).forEach(([key, value]) => {
				// Skip if it's a system header (already added)
				if (!systemHeaderKeys.has(key.toLowerCase())) {
					items.push({
						id: generateId(),
						key,
						value,
						enabled: true,
					});
				}
			});
		}
	} else {
		// For params and other non-header key-value pairs, just convert the record
		if (record) {
			Object.entries(record).forEach(([key, value]) => {
				items.push({
					id: generateId(),
					key,
					value,
					enabled: true,
				});
			});
		}
	}

	// Always add an empty row at the end for new entries
	items.push(createEmptyKeyValue());
	return items;
};
