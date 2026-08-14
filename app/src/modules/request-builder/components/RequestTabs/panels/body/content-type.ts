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
 * That rule now lives in `utils/auto-header.ts`, because the Event stream
 * toggle needs the identical one for `Accept` (issue #574). What stays here is
 * the only part that is about bodies: **which** Content-Type a mode requires.
 * The rule is small but it is a *rule*, so it lives in a module rather than
 * inside a click handler, where the only way to exercise it is to drive a Radix
 * Select through jsdom - which does not commit a value there.
 */

import type { KeyValueEntry, KeyValueItem } from "@/types";
import type { AutoHeader, BodyMode } from "../../../../types";
import {
	autoHeaderRow,
	autoHeaderToAdd,
	switchAutoHeader,
	withoutAutoHeader,
	type AutoHeaderSwitch,
} from "../../../../utils/auto-header";

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
 * Typed on `KeyValueEntry` rather than the UI's `KeyValueItem` because the
 * importers ask the same question of rows that have no `id` yet. An imported
 * GraphQL request used to reach the wire as `x-www-form-urlencoded` - libcurl's
 * default - because this fired only on an interactive mode switch, and most
 * GraphQL servers answer that with a 400.
 */
export function contentTypeToAdd(mode: BodyMode, headers: KeyValueEntry[]): string | null {
	return autoHeaderToAdd(CONTENT_TYPE, requiredContentType(mode), headers);
}

/** The header list with the row this panel added taken back out. */
export function withoutContentType(headers: KeyValueItem[], auto: AutoHeader): KeyValueItem[] {
	return withoutAutoHeader(headers, CONTENT_TYPE, auto);
}

/** The header row to append, ready for `updateField("headers", …)`. */
export function contentTypeRow(value: string): KeyValueItem {
	return autoHeaderRow(CONTENT_TYPE, value);
}

export type ContentTypeSwitch = AutoHeaderSwitch;

/**
 * Remove the header the old mode needed, add the one the new mode does.
 *
 * `requestId` is the request being edited *now*; see `switchAutoHeader` for
 * why a record belonging to another request is dropped rather than applied,
 * and why both halves happen in one pass over one array.
 */
export function switchContentType(
	mode: BodyMode,
	headers: KeyValueItem[],
	requestId: string | null,
	auto: AutoHeader | null
): ContentTypeSwitch {
	return switchAutoHeader(CONTENT_TYPE, requiredContentType(mode), headers, requestId, auto);
}
