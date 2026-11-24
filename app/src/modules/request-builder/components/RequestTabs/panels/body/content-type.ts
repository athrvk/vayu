/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Which Content-Type a body mode requires. Choosing GraphQL adds a header on a tab the user is not
 * looking at, and **leaving GraphQL takes it back**: otherwise one visit left
 * `Content-Type: application/json` on the request for good, sent even under None. The panel
 * remembers the row it wrote, by id: a Content-Type the *user* typed must survive a mode change and
 * is indistinguishable by value. That add-and-reclaim rule is `utils/auto-header.ts`, shared with
 * the Event stream toggle's `Accept` (#574); only the per-mode type is here. A module, not a click
 * handler, since exercising a handler means driving a Radix Select through jsdom, which does not
 * commit a value.
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
 * - GraphQL's `{ query, variables }` and JSON-RPC's `"jsonrpc":"2.0"` are JSON envelopes the engine
 *   completes; a server reading either answers anything else with a 400, so the header is part of
 *   the mode.
 * - `xml` has no envelope and goes verbatim, but a SOAP or legacy endpoint reads XML only when the
 *   request says so; without this it goes as libcurl's default `application/x-www-form-urlencoded`.
 * - `mcp` is absent though JSON on the wire: the engine derives its Content-Type with the other MCP
 *   headers (`Accept`, `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`, `Mcp-Param-*`, #3762), and
 *   a row here would copy one of them alone. The panel shows that none is typed by hand.
 * - `json`, the most common mode, gets the auto-write rather than staying silent about what the
 *   engine implies.
 * - `text` is absent: the engine derives `text/plain` at send, so a Content-Type the user types for
 *   a CSV or a JWT is the only one and needs no row removed first.
 *
 * The app-side half of the engine's `implied_content_type` (`engine/src/http/form_body.cpp`): the
 * same type per listed mode. The engine's reaches the wire; this drives the row the panel writes,
 * so the user sees and edits what goes. `implied-content-type.conformance.test.ts` holds both to
 * one fixture.
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
 * The Content-Type this mode change should add, or null: when the mode needs none, and when the
 * request already declares one, even a *different* one (a hand-set `application/graphql` is meant,
 * and replacing it would be worse than the bug this fixes). A disabled row declares nothing, as it
 * is not sent. Typed on `KeyValueEntry`, not `KeyValueItem`, since importers ask this of rows with
 * no `id` yet.
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
