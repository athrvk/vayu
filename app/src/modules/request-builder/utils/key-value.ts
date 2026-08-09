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
 * There is no conversion to/from Record<string,string> for storage - that was
 * the source of silent data loss. Flat headers are only built for HTTP execution.
 */

import type { FormFieldEntry } from "@/types";
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
 * Ensure the list ends with exactly one blank row, so there is always somewhere
 * to type without pressing "add".
 *
 * The rule was written twice inside `KeyValueEditor` - once in `handleRemove`
 * and once in `handleUpdate` - with conditions that had already drifted apart:
 * the remove path appended a blank when the list emptied *or* when the last row
 * had content, while the update path only appended when the row being edited
 * was the last one. Delete the second-to-last row while the last is blank and
 * neither branch tidied up.
 *
 * One definition, applied to whatever the caller produces.
 */
export const withTrailingBlank = (items: KeyValueItem[]): KeyValueItem[] => {
	const last = items[items.length - 1];
	return last && isBlankRow(last) ? items : [...items, createEmptyKeyValue()];
};

/**
 * Nothing typed and no file chosen.
 *
 * A file part keeps its content in `src`, not in `value`, so a row holding only
 * a picked file reads as blank to a key/value test - it would have been treated
 * as the trailing spare row and dropped on save.
 */
const isBlankRow = (item: KeyValueItem): boolean =>
	!item.key.trim() && !item.value.trim() && !item.src?.trim();

/**
 * Convert domain KeyValueEntry[] to UI KeyValueItem[].
 * Adds ephemeral `id` for React keys.
 * When `withSystemHeaders` is true, injects managed system headers at the top.
 */
export const toKeyValueItems = (
	entries: FormFieldEntry[] | undefined,
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
 * Convert UI KeyValueItem[] back to domain entries.
 * Strips the ephemeral `id` and `system` fields.
 * Blank trailing rows are omitted (see `isBlankRow`).
 *
 * The result is typed as `FormFieldEntry[]` - a superset of `KeyValueEntry`
 * whose extra members are all optional - so a form-data row keeps its file
 * part on the way to storage while headers and params are unaffected.
 */
export const toKeyValueEntries = (items: KeyValueItem[]): FormFieldEntry[] => {
	return items
		.filter((item) => !isBlankRow(item))
		.map(({ id: _id, system: _sys, ...entry }) => entry);
};

/**
 * Build a flat Record<string,string> from KeyValueItems for HTTP execution.
 * Only enabled rows with non-empty keys are included.
 * Last value wins when duplicate keys exist (allows user headers to override system headers).
 * This is ONLY used for the engine execution endpoint - never for storage.
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
