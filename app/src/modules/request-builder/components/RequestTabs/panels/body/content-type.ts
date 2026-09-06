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
import type { BodyMode } from "../../../../types";
import {
	autoHeaderRow,
	autoHeaderToAdd,
	switchAutoHeader,
	withoutAutoHeader,
	type AutoHeaderSwitch,
} from "../../../../utils/auto-header";

/** The marker this panel writes on the row it owns - see `utils/auto-header.ts`. */
const SOURCE = "body-mode" as const;

export const CONTENT_TYPE = "Content-Type";

/**
 * The first two are JSON envelopes the engine completes on the way to the wire:
 * GraphQL's `{ query, variables }`, and JSON-RPC's `"jsonrpc":"2.0"` frame. A
 * server that reads either out of a JSON object answers anything else with a
 * 400, so the header is not a nicety - it is part of what the mode means.
 *
 * `xml` has no envelope and is sent verbatim, but it earns the same rule for the
 * same reason: a SOAP or legacy-enterprise endpoint reads the body as XML only
 * when the request says it is, and without this the document goes out under
 * libcurl's default `application/x-www-form-urlencoded`.
 *
 * `json` is the Body panel's most common mode, so it earns the same auto-write
 * rather than staying silent about what the engine already implies for it.
 * `text` is deliberately absent: it is the mode a user reaches for precisely
 * to write the header themselves, and it implies nothing on the engine side.
 *
 * This table is the app-side half of the engine's `implied_content_type`
 * (`engine/src/http/form_body.cpp`); the two must name the same type per mode.
 * The engine's is what actually reaches the wire - this one drives the header
 * row the panel writes, so the user can see and edit what will be sent.
 */
const REQUIRED_CONTENT_TYPE: Partial<Record<BodyMode, string>> = {
	json: "application/json",
	graphql: "application/json",
	jsonrpc: "application/json",
	xml: "application/xml",
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
export function withoutContentType(headers: KeyValueItem[]): KeyValueItem[] {
	return withoutAutoHeader(headers, CONTENT_TYPE, SOURCE);
}

/** The header row to append, ready for `updateField("headers", …)`. */
export function contentTypeRow(value: string): KeyValueItem {
	return autoHeaderRow(CONTENT_TYPE, value, SOURCE);
}

export type ContentTypeSwitch = AutoHeaderSwitch;

/** Remove the header the old mode needed, add the one the new mode does. */
export function switchContentType(mode: BodyMode, headers: KeyValueItem[]): ContentTypeSwitch {
	return switchAutoHeader(CONTENT_TYPE, requiredContentType(mode), headers, SOURCE);
}
