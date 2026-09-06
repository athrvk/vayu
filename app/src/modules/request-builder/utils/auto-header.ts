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
 * - **ownership by marker, never by value.** A header the *user* typed must
 *   survive the setting changing, and it is indistinguishable by value.
 *   Ownership used to live in a ref the provider held, keyed by row id and
 *   value - which meant nothing survived a reload, and a stale auto-written
 *   row was then indistinguishable from the user's own (issue #1481). The
 *   `source` field on the row itself is the fact, stored where the row is.
 * - **never override a declaration**. A request that already declares the
 *   header - even with a *different* value - keeps what it has; silently
 *   replacing it would be a worse version of the bug this exists to fix.
 * - **one array, one pass**. Removing the old header and adding the new one are
 *   done together, because a caller doing them as two `updateField("headers")`
 *   calls would compute the second against the headers it had before the first.
 *
 * A disabled row does not count as declaring the header - it is not sent, so
 * the request would go out without it. Editing a marked row's key or value by
 * hand clears the marker (`KeyValueEditor`'s `handleUpdate`) - once retyped, it
 * is the user's, and stays even if the new value happens to match.
 */

import type { AutoHeaderSource, KeyValueEntry, KeyValueItem } from "@/types";
import { generateId } from "@/lib/id";

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

/** Is this the row the given setting owns? */
const isOurs = (item: KeyValueEntry, name: string, source: AutoHeaderSource) =>
	item.source === source && isNamed(item, name);

/** The header list with the row this setting owns taken back out. */
export function withoutAutoHeader(
	headers: KeyValueItem[],
	name: string,
	source: AutoHeaderSource
): KeyValueItem[] {
	return headers.filter((h) => !isOurs(h, name, source));
}

/** The header row to append, ready for `updateField("headers", …)`. */
export function autoHeaderRow(name: string, value: string, source: AutoHeaderSource): KeyValueItem {
	return { id: generateId(), key: name, value, enabled: true, source };
}

export interface AutoHeaderSwitch {
	/** Headers for the new setting. The same array when nothing changed. */
	headers: KeyValueItem[];
	/** The value just added, for a notice, or null if nothing was added. */
	added: string | null;
}

/**
 * Remove the header the old setting needed, add the one the new setting does.
 *
 * @param name     Header name this record owns a row for (`Content-Type`, `Accept`).
 * @param required The value the setting now needs, or null when it needs none.
 * @param headers  The request's current header rows.
 * @param source   Which setting is asking - the marker it writes and reads.
 *
 * Switching between two settings that need the *same* header keeps the row
 * rather than removing and re-adding it, which would churn the Headers tab and
 * lose the row's position.
 */
export function switchAutoHeader(
	name: string,
	required: string | null,
	headers: KeyValueItem[],
	source: AutoHeaderSource
): AutoHeaderSwitch {
	const owned = headers.find((h) => isOurs(h, name, source));
	if (owned && owned.value === required) return { headers, added: null };

	const next = owned ? withoutAutoHeader(headers, name, source) : headers;
	const toAdd = autoHeaderToAdd(name, required, next);
	if (!toAdd) return { headers: next, added: null };

	return { headers: [...next, autoHeaderRow(name, toAdd, source)], added: toAdd };
}
