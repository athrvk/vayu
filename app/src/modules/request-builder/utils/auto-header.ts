/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A header a *setting* adds to the request, and takes back when the setting
 * changes.
 *
 * The rule was written once for the body mode's `Content-Type` (see
 * `panels/body/content-type.ts` for the bug that produced it: nothing removed
 * the header, so one visit to GraphQL left `Content-Type: application/json` on
 * the request for good). The Event stream toggle needs exactly the same rule
 * for `Accept: text/event-stream` (issue #574), so it lives here rather than
 * being written a second time - a hand-rolled copy of a primitive does not
 * receive the primitive's fixes, and this one has three parts that are easy to
 * get subtly different:
 *
 * - **ownership by row id**, never by value. A header the *user* typed must
 *   survive the setting changing, and it is indistinguishable by value.
 * - **never override a declaration**. A request that already declares the
 *   header - even with a *different* value - keeps what it has; silently
 *   replacing it would be a worse version of the bug this exists to fix.
 * - **one array, one pass**. Removing the old header and adding the new one are
 *   done together, because a caller doing them as two `updateField("headers")`
 *   calls would compute the second against the headers it had before the first.
 *
 * A disabled row does not count as declaring the header - it is not sent, so
 * the request would go out without it.
 */

import type { KeyValueEntry, KeyValueItem } from "@/types";
import { generateId } from "@/lib/id";
import type { AutoHeader } from "../types";

/** Case-insensitive header-name match, on the trimmed key. */
const isNamed = (item: KeyValueEntry, name: string) =>
	item.key.trim().toLowerCase() === name.toLowerCase();

/**
 * The value this setting should add, or null if nothing should be added.
 *
 * Null when the setting requires no header, and null when the request already
 * declares one.
 *
 * Typed on `KeyValueEntry` rather than the UI's `KeyValueItem`: the rule reads
 * only `key` and `enabled`, and the importers ask the same question of rows
 * that have no `id` yet.
 */
export function autoHeaderToAdd(
	name: string,
	required: string | null,
	headers: KeyValueEntry[]
): string | null {
	if (!required) return null;
	return headers.some((h) => isNamed(h, name) && h.enabled) ? null : required;
}

/**
 * Is this the row we wrote, unchanged?
 *
 * A row the user has since retyped - a different value, or a different header
 * name - is theirs now, and stays. Being switched off does not hand it over:
 * disabling our row is not the same as adopting it.
 */
const isOurs = (item: KeyValueItem, name: string, auto: AutoHeader) =>
	item.id === auto.rowId && isNamed(item, name) && item.value === auto.value;

/** The header list with the row this setting added taken back out. */
export function withoutAutoHeader(
	headers: KeyValueItem[],
	name: string,
	auto: AutoHeader
): KeyValueItem[] {
	return headers.filter((h) => !isOurs(h, name, auto));
}

/** The header row to append, ready for `updateField("headers", …)`. */
export function autoHeaderRow(name: string, value: string): KeyValueItem {
	return { id: generateId(), key: name, value, enabled: true };
}

export interface AutoHeaderSwitch {
	/** Headers for the new setting. The same array when nothing changed. */
	headers: KeyValueItem[];
	/** The row this setting now owns, or null if it owns none. */
	auto: AutoHeader | null;
	/** The value just added, for a notice, or null if nothing was added. */
	added: string | null;
}

/**
 * Remove the header the old setting needed, add the one the new setting does.
 *
 * @param name     Header name this record owns a row for (`Content-Type`, `Accept`).
 * @param required The value the setting now needs, or null when it needs none.
 * @param headers  The request's current header rows.
 * @param requestId The request being edited *now*. A record belonging to
 *   another request is dropped rather than applied - the provider's ref
 *   outlives the request that filled it, and row ids are not unique across a
 *   duplicated request.
 * @param auto     The row this setting owned before the change.
 *
 * Switching between two settings that need the *same* header keeps the row (and
 * the record with it) rather than removing and re-adding it, which would churn
 * the Headers tab and lose the row's position.
 */
export function switchAutoHeader(
	name: string,
	required: string | null,
	headers: KeyValueItem[],
	requestId: string | null,
	auto: AutoHeader | null
): AutoHeaderSwitch {
	let next = headers;
	let ours = auto?.requestId === requestId ? auto : null;

	if (ours && required !== ours.value) {
		next = withoutAutoHeader(next, name, ours);
		ours = null;
	}

	const toAdd = autoHeaderToAdd(name, required, next);
	if (!toAdd) return { headers: next, auto: ours, added: null };

	const row = autoHeaderRow(name, toAdd);
	return {
		headers: [...next, row],
		auto: { requestId, rowId: row.id, value: toAdd },
		added: toAdd,
	};
}
