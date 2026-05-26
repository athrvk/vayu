/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Key-Value Utilities
 *
 * Helpers for converting between the domain KeyValueEntry[] (storage) and
 * the UI-layer KeyValueItem[] (adds ephemeral `id` for React keys).
 *
 * There is no conversion to/from Record<string,string> for storage — that was
 * the source of silent data loss. Flat headers are only built for HTTP execution.
 */

import type { KeyValueEntry } from "@/types";
import type { KeyValueItem } from "../types";
import { generateId } from "./id";
import { createDefaultSystemHeaders } from "./system-headers";

/**
 * Create an empty KeyValueItem for a new editor row.
 */
export const createEmptyKeyValue = (): KeyValueItem => ({
	id: generateId(),
	key: "",
	value: "",
	enabled: true,
});

/**
 * Convert domain KeyValueEntry[] to UI KeyValueItem[].
 * Adds ephemeral `id` for React keys.
 * When `withSystemHeaders` is true, injects managed system headers at the top.
 */
export const toKeyValueItems = (
	entries: KeyValueEntry[] | undefined,
	withSystemHeaders = false
): KeyValueItem[] => {
	const items: KeyValueItem[] = [];

	if (withSystemHeaders) {
		items.push(...createDefaultSystemHeaders());
		const systemKeys = new Set(items.map((h) => h.key.toLowerCase()));
		(entries ?? []).forEach((entry) => {
			if (!systemKeys.has(entry.key.toLowerCase())) {
				items.push({ ...entry, id: generateId() });
			}
		});
	} else {
		(entries ?? []).forEach((entry) => {
			items.push({ ...entry, id: generateId() });
		});
	}

	// Always keep an empty trailing row for new entries
	items.push(createEmptyKeyValue());
	return items;
};

/**
 * Convert UI KeyValueItem[] back to domain KeyValueEntry[].
 * Strips the ephemeral `id` and `system` fields.
 * Empty trailing rows (no key AND no value) are omitted.
 */
export const toKeyValueEntries = (items: KeyValueItem[]): KeyValueEntry[] => {
	return items
		.filter((item) => item.key.trim() || item.value.trim())
		.map(({ id: _id, system: _sys, ...entry }) => entry);
};

/**
 * Build a flat Record<string,string> from KeyValueItems for HTTP execution.
 * Only enabled rows with non-empty keys are included.
 * Last value wins when duplicate keys exist (allows user headers to override system headers).
 * This is ONLY used for the engine execution endpoint — never for storage.
 */
export const toFlatHeaders = (items: KeyValueItem[]): Record<string, string> => {
	const result: Record<string, string> = {};
	items.forEach((item) => {
		if (item.enabled && item.key.trim()) {
			result[item.key] = item.value;
		}
	});
	return result;
};
