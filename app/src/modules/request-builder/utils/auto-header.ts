/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A header a *setting* adds to the request and takes back when the setting changes: the body mode's
 * `Content-Type` (`panels/body/content-type.ts`) and the Event stream toggle's
 * `Accept: text/event-stream` (#574), one rule so neither copy misses the other's fixes. Its parts:
 *
 * - **ownership by marker, never by value.** A header the *user* typed must survive the setting
 *   changing and is indistinguishable by value; the row's `source` is the fact (#1481).
 * - **never override a declaration.** A request already declaring the header, even differently,
 *   keeps it; replacing it would be worse than the bug this fixes.
 * - **one array, one pass.** Removing the old header and adding the new happen together: two
 *   `updateField("headers")` calls would compute the second against the pre-first headers.
 *
 * A disabled row declares nothing: it is not sent. Hand-editing a marked row's key or value clears
 * the marker (`KeyValueEditor`'s `handleUpdate`): retyped, it is the user's, even if it matches.
 */

import type { AutoHeaderSource, KeyValueEntry, KeyValueItem } from "@/types";
import {
	ACCEPT_HEADER,
	DEFAULT_STREAM_FIRST_CONTENT_MARKER,
	DEFAULT_STREAM_TEXT_PATH,
	SSE_ACCEPT,
} from "@/constants/request";
import { generateId } from "@/lib/id";

/** Case-insensitive header-name match, on the trimmed key. */
const isNamed = (item: KeyValueEntry, name: string) =>
	item.key.trim().toLowerCase() === name.toLowerCase();

/**
 * The value this setting should add, or null: when it needs no header, or the request already
 * declares one. Typed on `KeyValueEntry`, not `KeyValueItem`: it reads only `key` and `enabled`,
 * and importers ask it of rows with no `id` yet.
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
 * @param source   Which setting is asking: the marker it writes and reads.
 *
 * Two settings needing the *same* header keep the row rather than remove and re-add it, which would
 * churn the Headers tab and lose its position.
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

/**
 * What the Event stream setting changes: the flag, its `Accept` row and, going off, the text path
 * (#3773) and first content marker (#3774).
 */
export interface StreamPatch {
	stream: boolean;
	headers: KeyValueItem[];
	streamTextPath?: string;
	streamFirstContentMarker?: string;
}

/**
 * The fields turning Event stream on or off writes, as one `setRequest` patch. Flag and `Accept`
 * row are one change ("one array, one pass"), so every toggle (the Settings tab's switch, the Body
 * tab's "Enable event stream") takes this patch rather than set `stream` alone, which would leave
 * out the header a stream server negotiates on.
 */
export function streamPatch(
	request: {
		headers: KeyValueItem[];
		streamTextPath?: string;
		streamFirstContentMarker?: string;
	},
	on: boolean
): StreamPatch {
	const next = switchAutoHeader(ACCEPT_HEADER, on ? SSE_ACCEPT : null, request.headers, "stream");
	const patch: StreamPatch = { stream: on, headers: next.headers };
	// A path and a marker belong to a stream: the engine refuses one beside a buffered request, so
	// they empty with the toggle rather than have the save send a pair it refuses.
	if (on) return patch;
	if (request.streamTextPath) patch.streamTextPath = DEFAULT_STREAM_TEXT_PATH;
	if (request.streamFirstContentMarker)
		patch.streamFirstContentMarker = DEFAULT_STREAM_FIRST_CONTENT_MARKER;
	return patch;
}
