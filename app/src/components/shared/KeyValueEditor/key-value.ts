/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The table's row model.
 *
 * Converting between the domain `FormFieldEntry[]` (storage) and the UI-layer
 * `KeyValueItem[]` (adds an ephemeral `id` for React keys), plus the trailing
 * blank row rule. This is the vocabulary of the table itself, so it lives with
 * the table rather than in the request builder - the inbox mounts the same
 * primitive and needs the same conversion (issue #567).
 *
 * What stayed behind in `modules/request-builder/utils/key-value.ts` is
 * `toHeaderRows`, which is execution-shaped: it builds the ordered header lines
 * for the engine's execute and compose endpoints and no table ever asks for it.
 *
 * There is no conversion to/from Record<string,string> for storage - that was
 * the source of silent data loss, and a record cannot send a repeated header
 * either (issue #2466).
 */

import type { FormFieldEntry, KeyValueItem } from "@/types";
import { generateId } from "@/lib/id";

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
export const isBlankRow = (item: KeyValueItem): boolean =>
	!item.key.trim() && !item.value.trim() && !item.src?.trim();

/**
 * Convert domain KeyValueEntry[] to UI KeyValueItem[].
 * Adds ephemeral `id` for React keys, and the trailing blank row.
 *
 * System headers are *not* injected here. They are the request builder's own
 * notion (`User-Agent`, `X-Vayu-Version`, `X-Request-ID`) and a shared table
 * has no business knowing them - `toHeaderItems` in
 * `modules/request-builder/utils/system-headers.ts` puts them in front of this.
 */
export const toKeyValueItems = (entries: FormFieldEntry[] | undefined): KeyValueItem[] => {
	const items: KeyValueItem[] = (entries ?? []).map((entry) => ({
		...entry,
		id: generateId(),
	}));

	// Always keep an empty trailing row for new entries
	items.push(createEmptyKeyValue());
	return items;
};

/**
 * Convert UI KeyValueItem[] back to domain entries.
 * Strips the ephemeral `id` field.
 * Blank trailing rows are omitted (see `isBlankRow`).
 *
 * The result is typed as `FormFieldEntry[]` - a superset of `KeyValueEntry`
 * whose extra members are all optional - so a form-data row keeps its file
 * part on the way to storage while headers and params are unaffected.
 */
export const toKeyValueEntries = (items: KeyValueItem[]): FormFieldEntry[] => {
	return items.filter((item) => !isBlankRow(item)).map(({ id: _id, ...entry }) => entry);
};

/**
 * Whether two rows say the same thing, member by member: the engine stores a
 * row as JSON and hands its members back in another order, so a serialised
 * compare would read an unchanged row as edited. An absent member and one set
 * to `undefined` agree. The `id` takes no part.
 */
const sameEntry = (a: FormFieldEntry, b: FormFieldEntry): boolean => {
	const left: Record<string, unknown> = { ...a, id: undefined };
	const right: Record<string, unknown> = { ...b, id: undefined };
	const members = new Set([...Object.keys(left), ...Object.keys(right)]);
	return [...members].every((member) => left[member] === right[member]);
};

/**
 * Whether two tables store the same rows (#3663): compared as the entries
 * `toKeyValueEntries` saves, so neither the ephemeral ids nor the spare blank
 * row make a refetched table read as changed.
 */
export const sameRows = (a: KeyValueItem[], b: KeyValueItem[]): boolean => {
	const left = toKeyValueEntries(a);
	const right = toKeyValueEntries(b);
	return left.length === right.length && left.every((entry, i) => sameEntry(entry, right[i]));
};

/**
 * `next` with each row's id taken from the first row of `previous` it
 * `restates`, each previous row claimed once and in order, so of two identical
 * rows the first keeps the first's id. A row that restates nothing keeps its
 * own id.
 */
export function carryIds<T extends { id: string }>(
	previous: readonly T[],
	next: readonly T[],
	restates: (previous: T, next: T) => boolean
): T[] {
	const claimed = new Array<boolean>(previous.length).fill(false);
	return next.map((row) => {
		const match = previous.findIndex((prev, i) => !claimed[i] && restates(prev, row));
		if (match === -1) return row;
		claimed[match] = true;
		return { ...row, id: previous[match].id };
	});
}

/**
 * `incoming` rows, freshly converted from storage, with the ids of the
 * `current` rows they restate (#3663), so adopting a refetched table remounts
 * only the rows whose content changed and a caret in any other row stays put.
 * Rows are keyed by id, so a fresh id is a remount.
 *
 * Blank rows restate nothing by content: the spare row instead keeps the id of
 * the current table's last blank row, so a caret left in it survives too.
 */
export function carryRowIds(
	current: readonly KeyValueItem[],
	incoming: readonly KeyValueItem[]
): KeyValueItem[] {
	const carried = carryIds(
		current.filter((row) => !isBlankRow(row)),
		incoming,
		(prev, next) => !isBlankRow(next) && sameEntry(prev, next)
	);
	const spare = current[lastBlankIndex(current)];
	const incomingSpare = lastBlankIndex(carried);
	if (!spare || incomingSpare === -1) return carried;
	return carried.map((row, i) => (i === incomingSpare ? { ...row, id: spare.id } : row));
}

function lastBlankIndex(rows: readonly KeyValueItem[]): number {
	for (let i = rows.length - 1; i >= 0; i--) if (isBlankRow(rows[i])) return i;
	return -1;
}

/**
 * `item` with the file name its part is sent under set to `name`, or without
 * one when `name` is empty: the engine then sends the file's own name (#3022).
 */
export function withFileName(item: KeyValueItem, name: string): KeyValueItem {
	const { fileName: _previous, ...rest } = item;
	return name === "" ? rest : { ...rest, fileName: name };
}
