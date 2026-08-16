/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Turning the response on screen into a stored example (issue #588).
 *
 * Kept out of the dialog because this is the part with a contract: what an
 * app-saved example holds has to match what an importer would have written for
 * the same response, or the mock server would answer differently depending on
 * where its route table came from. The two rules that could drift are both
 * here - the Content-Type lookup is the Postman importer's, header for header
 * (`importers/postman.ts`), and `order` is never sent so the engine appends.
 */

import type { CreateRequestExampleRequest, KeyValueEntry } from "@/types";
import type { ResponseState } from "../../types";

/**
 * The name a save starts with: the status line, which is what a saved response
 * is usually called and is unique enough to tell two of them apart at a glance.
 *
 * Editable at save time - this is a starting point, not a scheme.
 *
 * It used to append " (truncated body)" for a capped response, because the
 * engine had no column to carry the fact and the name was the only field the
 * panel lists. That made the disclosure droppable: the field is editable, so
 * renaming a partial example at save time left a row that reads as complete and
 * a mock server that serves it as one. The engine records `bodyTruncated` now
 * (issue #659) and the panel chips it, so the name is back to being just a
 * name - a user may call an example whatever they like without erasing what it
 * is.
 */
export function defaultExampleName(response: ResponseState): string {
	return response.statusText
		? `${response.status} ${response.statusText}`
		: String(response.status);
}

/** The response's headers as stored entries, in the order they are held. */
function headerEntries(headers: Record<string, string>): KeyValueEntry[] {
	return Object.entries(headers).map(([key, value]) => ({ key, value, enabled: true }));
}

/**
 * The create payload for @p response under @p name.
 *
 * `contentType` is the response's own Content-Type header verbatim, looked up
 * case-insensitively - the same rule and the same "" fallback the Postman
 * importer uses, rather than a media type parsed out of it. The engine
 * denormalizes this column for the mock server, and a value that disagrees with
 * the header beside it is the kind of difference that only shows up when
 * something is served.
 */
export function exampleFromResponse(
	response: ResponseState,
	name: string
): CreateRequestExampleRequest {
	const headers = headerEntries(response.headers);
	return {
		name,
		status: response.status,
		headers,
		body: response.body,
		contentType: headers.find((h) => h.key.toLowerCase() === "content-type")?.value ?? "",
		// Always `user`: this is the field a spec sync reads to know it must
		// leave the row alone (#627). An app-saved example is never a spec's.
		origin: "user",
		// `?? false` rather than passing it through: `ResponseState` leaves the
		// flag optional for responses that never went through a trace, and an
		// absent one there means "not truncated", not "unknown".
		bodyTruncated: response.bodyTruncated ?? false,
	};
}
