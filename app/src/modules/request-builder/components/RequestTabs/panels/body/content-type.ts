/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Choosing GraphQL adds a header to the request, which is a side effect on a
 * tab you are not looking at - and **leaving GraphQL takes it back**.
 *
 * Adding it was only ever half the rule. Nothing removed it, so one visit to
 * GraphQL left `Content-Type: application/json` on the request for good: switch
 * back to None, which sends no body at all, and the header was still there,
 * still going out on every send. The notice below the mode picker offered an
 * Undo, but only while the panel was mounted and only until it was dismissed.
 *
 * So the panel remembers the row it wrote - which row, by id, and with what
 * value - and a mode change that no longer needs that header removes it. Row id
 * rather than "a Content-Type whose value is application/json", because those
 * are not the same header: a Content-Type the *user* typed must survive a mode
 * change, and it is indistinguishable by value.
 *
 * The rule is small but it is a *rule*, so it lives here rather than inside a
 * click handler, where the only way to exercise it is to drive a Radix Select
 * through jsdom - which does not commit a value there.
 */

import type { KeyValueEntry } from "@/types";
import type { AutoContentType, BodyMode } from "../../../../types";
import type { KeyValueItem } from "@/types";
import { generateId } from "@/lib/id";

export const CONTENT_TYPE = "Content-Type";

/**
 * Both entries are JSON envelopes the engine completes on the way to the wire:
 * GraphQL's `{ query, variables }`, and JSON-RPC's `"jsonrpc":"2.0"` frame. A
 * server that reads either out of a JSON object answers anything else with a
 * 400, so the header is not a nicety - it is part of what the mode means.
 */
const REQUIRED_CONTENT_TYPE: Partial<Record<BodyMode, string>> = {
	graphql: "application/json",
	jsonrpc: "application/json",
};

const isContentType = (item: KeyValueEntry) =>
	item.key.trim().toLowerCase() === CONTENT_TYPE.toLowerCase();

/** The Content-Type a mode must be sent with, or null if it needs none. */
export function requiredContentType(mode: BodyMode): string | null {
	return REQUIRED_CONTENT_TYPE[mode] ?? null;
}

/**
 * The Content-Type this mode change should add, or null if none is needed.
 *
 * Null when the mode requires nothing, and null when the request already
 * declares one - including a *different* one, which is deliberate: someone who
 * has set `application/graphql` by hand means it, and silently replacing it
 * would be a worse version of the bug this whole thing is about.
 *
 * A disabled Content-Type row does not count as declaring one - it is not sent,
 * so the request would go out without the header.
 *
 * Typed on `KeyValueEntry` rather than the UI's `KeyValueItem`: the rule reads
 * only `key` and `enabled`, and the importers ask the same question of rows
 * that have no `id` yet. An imported GraphQL request used to reach the wire as
 * `x-www-form-urlencoded` - libcurl's default - because this fired only on an
 * interactive mode switch, and most GraphQL servers answer that with a 400.
 */
export function contentTypeToAdd(mode: BodyMode, headers: KeyValueEntry[]): string | null {
	const required = requiredContentType(mode);
	if (!required) return null;
	return headers.some((h) => isContentType(h) && h.enabled) ? null : required;
}

/**
 * Is this the row we wrote, unchanged?
 *
 * A row the user has since retyped - a different value, or a different header
 * name - is theirs now, and stays. Being switched off does not hand it over:
 * disabling our row is not the same as adopting it.
 */
const isOurs = (item: KeyValueItem, auto: AutoContentType) =>
	item.id === auto.rowId && isContentType(item) && item.value === auto.value;

/** The header list with the row this panel added taken back out. */
export function withoutContentType(headers: KeyValueItem[], auto: AutoContentType): KeyValueItem[] {
	return headers.filter((h) => !isOurs(h, auto));
}

/** The header row to append, ready for `updateField("headers", …)`. */
export function contentTypeRow(value: string): KeyValueItem {
	return { id: generateId(), key: CONTENT_TYPE, value, enabled: true };
}

export interface ContentTypeSwitch {
	/** Headers for the new mode. The same array when nothing changed. */
	headers: KeyValueItem[];
	/** The row this panel now owns, or null if it owns none. */
	auto: AutoContentType | null;
	/** The value just added, for the notice, or null if nothing was added. */
	added: string | null;
}

/**
 * Remove the header the old mode needed, add the one the new mode does.
 *
 * Both halves in one place: they read and write the same array, and a panel
 * that did them as two `updateField("headers", …)` calls would compute the
 * second against the headers it had before the first.
 *
 * `requestId` is the request being edited *now*. A record belonging to another
 * request is dropped rather than applied - the provider's ref outlives the
 * request that filled it, and row ids are not unique across a duplicated
 * request.
 *
 * Switching between two modes that need the *same* header keeps the row (and
 * the record with it) rather than removing and re-adding it, which would churn
 * the Headers tab and lose the row's position.
 */
export function switchContentType(
	mode: BodyMode,
	headers: KeyValueItem[],
	requestId: string | null,
	auto: AutoContentType | null
): ContentTypeSwitch {
	let next = headers;
	let ours = auto?.requestId === requestId ? auto : null;

	if (ours && requiredContentType(mode) !== ours.value) {
		next = withoutContentType(next, ours);
		ours = null;
	}

	const required = contentTypeToAdd(mode, next);
	if (!required) return { headers: next, auto: ours, added: null };

	const row = contentTypeRow(required);
	return {
		headers: [...next, row],
		auto: { requestId, rowId: row.id, value: required },
		added: required,
	};
}
